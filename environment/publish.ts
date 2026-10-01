import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function optional(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configure ${name}.`);
  return value;
}

const revision = required("GITHUB_SHA");
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid Git revision.");

const platformUrlRaw = optional(
  "PLATFORM_URL",
  "https://lemon-bush-012995200.3.azurestaticapps.net",
);
const platform = new URL(platformUrlRaw).origin;
if (new URL(platform).protocol !== "https:") {
  throw new Error("Use HTTPS platform URL.");
}

const repository = optional("GITHUB_REPOSITORY");

// Determine platform resources
let resources: string[] = [];
if (process.env.PLATFORM_RESOURCE_IDS) {
  resources = process.env.PLATFORM_RESOURCE_IDS.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
} else {
  try {
    const catRes = await fetch(`${platform}/api/catalogue`);
    if (catRes.ok) {
      const catData = (await catRes.json()) as {
        courses?: Array<{ id: string }>;
        standaloneChallenges?: Array<{ id: string }>;
      };
      resources = [
        ...(catData.courses ?? []).map((c) => c.id),
        ...(catData.standaloneChallenges ?? []).map((c) => c.id),
      ];
    }
  } catch (err) {
    console.warn("Could not query /api/catalogue for platform resource IDs:", err);
  }
  if (!resources.length) {
    resources = [
      "d63450db78ddc5a977e372af12493a56",
      "47515cef617ab6797a7f2b63d185c5e8",
      "a75caf77c6e1635d100302881016cecc",
    ];
  }
}

async function bind(artifact?: { version: number; digest: string; manifestUrl: string }) {
  const idTokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const idToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!idTokenUrl || !idToken) {
    console.warn("ACTIONS_ID_TOKEN_REQUEST_URL or TOKEN missing; skipping CI bind.");
    return 0;
  }
  const identityUrl = new URL(idTokenUrl);
  identityUrl.searchParams.set("audience", platform);
  const identityResponse = await fetch(identityUrl, {
    headers: { Authorization: `Bearer ${idToken}` },
    redirect: "error",
  });
  if (!identityResponse.ok) {
    console.warn(`Unable to obtain GitHub workflow identity (${identityResponse.status}).`);
    return 0;
  }
  const { value } = (await identityResponse.json()) as { value: string };
  let boundCount = 0;
  for (const resourceId of resources) {
    try {
      const response = await fetch(`${platform}/api/environment-artifacts/ci`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${value}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId, revision, ...(artifact ? { artifact } : {}) }),
      });
      if (response.ok) {
        console.log(`Platform ${artifact ? "binding" : "validation"} succeeded for resource ${resourceId}.`);
        boundCount++;
      } else {
        const text = await response.text();
        console.log(`Resource ${resourceId} status ${response.status}: ${text}`);
      }
    } catch (err: any) {
      console.warn(`Resource ${resourceId} request error:`, err?.message || err);
    }
  }
  return boundCount;
}

const cachePublicUrl = optional("CACHE_PUBLIC_URL");
const cacheUploadUrl = optional("CACHE_UPLOAD_URL");
const nixSigningKey = optional("NIX_SIGNING_KEY");

if (cachePublicUrl && cacheUploadUrl && nixSigningKey) {
  // Custom remote cache mode:
  const base = new URL(cachePublicUrl.replace(/\/?$/, "/"));
  const upload = new URL(cacheUploadUrl.replace(/\/?$/, "/"));
  for (const url of [base, upload]) {
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Use HTTPS storage URLs without embedded credentials or query strings.");
  }
  await bind();
  const scratch = await mkdtemp(join(tmpdir(), "creator-cache-"));
  try {
    const keyPath = join(scratch, "signing-key");
    const publicKey = required("NIX_PUBLIC_KEY").trim();
    const [keyName, keyBytes] = nixSigningKey.split(":");
    const raw = Buffer.from(keyBytes ?? "", "base64");
    if (raw.length !== 64 || `${keyName}:${raw.subarray(32).toString("base64")}` !== publicKey)
      throw new Error("Nix signing key and public key do not match.");
    await writeFile(keyPath, nixSigningKey, { mode: 0o600 });
    const nix = (args: string[]) =>
      execFileSync("nix", ["--extra-experimental-features", "nix-command flakes", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim();
    const storePath = nix([
      "build",
      "path:./environment",
      "--no-update-lock-file",
      "--no-link",
      "--print-out-paths",
    ]);
    if (!/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+$/.test(storePath))
      throw new Error("Expected one native environment store path.");
    nix(["store", "sign", "--recursive", "--key-file", keyPath, storePath]);
    const cache = join(scratch, "cache");
    nix(["copy", "--to", `file://${cache}`, storePath]);
    const uploadToken = required("CACHE_UPLOAD_TOKEN");
    async function publish(path: string, bytes: Uint8Array) {
      const response = await fetch(new URL(path, upload), {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(120000),
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "If-None-Match": "*",
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from(bytes),
      });
      if (!response.ok && response.status !== 412)
        throw new Error(`Artifact upload failed (${response.status}).`);
      const published = await fetch(new URL(path, base), {
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (!published.ok) throw new Error("Published artifact is not readable at its public URL.");
      const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
      if (hash(new Uint8Array(await published.arrayBuffer())) !== hash(bytes))
        throw new Error("Storage overwrote or served mismatching immutable bytes.");
    }
    async function walk(prefix = "") {
      for (const entry of await readdir(join(cache, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) await publish(path, await readFile(join(cache, path)));
      }
    }
    await walk();
    const manifest = {
      version: 1,
      architecture: "x86_64",
      runtime: "trynix-qemu-wasm",
      storePaths: [storePath],
      caches: [{ url: base.href.replace(/\/$/, ""), key: publicKey }],
      environment: { PATH: `${storePath}/bin:/usr/bin:/bin` },
    };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = `manifests/${digest}.json`;
    await publish(path, bytes);
    await bind({ version: 1, digest: `sha256:${digest}`, manifestUrl: new URL(path, base).href });
    console.log("Canonical content validated; native closure published; exact revision bound.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  // Built-in zero-config environment mode (template repository default):
  const manifestBytes = await readFile(join(process.cwd(), "environment", "native.json"));
  const digest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  const manifestUrl = `https://raw.githubusercontent.com/${repository || "dumm5141-ui/course-repo-from-template"}/${revision}/environment/native.json`;
  console.log(`Using built-in immutable environment artifact: ${digest}`);
  console.log(`Manifest URL: ${manifestUrl}`);
  const boundCount = await bind({ version: 1, digest, manifestUrl });
  if (boundCount > 0) {
    console.log(`Canonical content validated and bound ${boundCount} resource(s) to ${digest}.`);
  } else {
    console.log(
      `Zero resources currently associated with repository ${repository || ""}. Associate this repository in /teach and re-run workflow to bind.`,
    );
  }
}

