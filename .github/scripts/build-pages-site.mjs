import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const command = process.argv[2] ?? "build-pages";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function scalar(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, "m"));
  return match?.[1] ?? "";
}

function block(yaml, key) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}: |`);
  if (start === -1) {
    return "";
  }

  const value = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }

    value.push(line.replace(/^  /, ""));
  }

  return value.join("\n").trimEnd() + "\n";
}

function quoteYaml(value) {
  return JSON.stringify(value);
}

function replaceScalar(yaml, key, value) {
  const line = `${key}: ${quoteYaml(value)}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");

  if (!pattern.test(yaml)) {
    return `${yaml.trimEnd()}\n${line}\n`;
  }

  return yaml.replace(pattern, line);
}

function replaceBlock(yaml, key, value) {
  const lines = yaml.split(/\r?\n/);
  const output = [];
  let replaced = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith(`${key}:`)) {
      output.push(line);
      continue;
    }

    replaced = true;
    output.push(`${key}: |`);
    for (const valueLine of value.replace(/\r\n/g, "\n").split("\n")) {
      output.push(`  ${valueLine}`);
    }

    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next && !next.startsWith(" ")) {
        break;
      }

      index += 1;
    }
  }

  if (!replaced) {
    output.push(`${key}: |`);
    for (const valueLine of value.replace(/\r\n/g, "\n").split("\n")) {
      output.push(`  ${valueLine}`);
    }
  }

  return `${output.join("\n").trimEnd()}\n`;
}

function patchBuildYaml() {
  const buildYamlPath = process.env.BUILD_YAML ?? "build.yaml";
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const repositoryOwner = requiredEnv("GITHUB_REPOSITORY_OWNER");
  const version = requiredEnv("PLUGIN_VERSION");
  const changelogFile = requiredEnv("CHANGELOG_FILE");
  const changelog = readFileSync(changelogFile, "utf8").trimEnd();

  let buildYaml = readFileSync(buildYamlPath, "utf8");
  buildYaml = replaceScalar(buildYaml, "version", version);
  buildYaml = replaceScalar(buildYaml, "owner", repositoryOwner);
  buildYaml = replaceScalar(
    buildYaml,
    "imageUrl",
    `https://raw.githubusercontent.com/${repository}/main/img/logo.png`,
  );
  buildYaml = buildYaml.replace(
    /^  Review documentation at .*$/m,
    `  Review documentation at https://github.com/${repository}`,
  );
  buildYaml = replaceBlock(
    buildYaml,
    "changelog",
    changelog || "No changelog provided.",
  );

  writeFileSync(buildYamlPath, buildYaml);
}

function pluginMetadata(buildYaml) {
  return {
    category: scalar(buildYaml, "category"),
    description: block(buildYaml, "description"),
    guid: scalar(buildYaml, "guid"),
    name: scalar(buildYaml, "name"),
    overview: scalar(buildYaml, "overview"),
    owner: scalar(buildYaml, "owner"),
  };
}

function releaseAssetUrl(repository, tagName, assetName) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(assetName)}`;
}

function findSingleZip(distDir) {
  const zipFiles = readdirSync(distDir).filter((name) => name.endsWith(".zip"));

  if (zipFiles.length !== 1) {
    throw new Error(
      `Expected exactly one zip in ${distDir}, found ${zipFiles.length}`,
    );
  }

  return zipFiles[0];
}

function prepareReleaseAssets() {
  const buildYamlPath = process.env.BUILD_YAML ?? "build.yaml";
  const distDir = process.env.DIST_DIR ?? "_dist";
  const assetDir = requiredEnv("RELEASE_ASSET_DIR");
  const version = requiredEnv("PLUGIN_VERSION");
  const tagName = requiredEnv("RELEASE_TAG");
  const repository = requiredEnv("GITHUB_REPOSITORY");

  const buildYaml = readFileSync(buildYamlPath, "utf8");
  const zipName = findSingleZip(distDir);
  const zipPath = join(distDir, zipName);
  const zipBytes = readFileSync(zipPath);
  const checksum = createHash("md5").update(zipBytes).digest("hex");
  const sha256 = createHash("sha256").update(zipBytes).digest("hex");
  const manifestEntry = {
    ...pluginMetadata(buildYaml),
    versions: [
      {
        changelog: block(buildYaml, "changelog"),
        checksum,
        sourceUrl: releaseAssetUrl(repository, tagName, zipName),
        targetAbi: scalar(buildYaml, "targetAbi"),
        timestamp: new Date().toISOString(),
        version,
      },
    ],
  };

  mkdirSync(assetDir, { recursive: true });
  copyFileSync(zipPath, join(assetDir, zipName));
  writeFileSync(join(assetDir, `${zipName}.md5`), `${checksum}  ${zipName}\n`);
  writeFileSync(join(assetDir, `${zipName}.sha256`), `${sha256}  ${zipName}\n`);
  writeFileSync(
    join(assetDir, "manifest-entry.json"),
    JSON.stringify(manifestEntry, null, 2) + "\n",
  );
}

function ghJson(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}

function gh(args) {
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function viewRelease(repository, tagName, { optional = false } = {}) {
  try {
    return ghJson([
      "release",
      "view",
      tagName,
      "--repo",
      repository,
      "--json",
      "assets,body,isDraft,isPrerelease,publishedAt,tagName",
    ]);
  } catch (error) {
    if (!optional) {
      throw error;
    }

    return null;
  }
}

function listStableReleases(repository) {
  return ghJson([
    "release",
    "list",
    "--repo",
    repository,
    "--exclude-drafts",
    "--exclude-pre-releases",
    "--limit",
    process.env.RELEASE_LIMIT ?? "100",
    "--json",
    "tagName",
  ]);
}

function loadManifestEntryAsset(repository, release, tempDir) {
  const asset = release.assets.find((item) => item.name === "manifest-entry.json");
  if (!asset) {
    return null;
  }

  gh([
    "release",
    "download",
    release.tagName,
    "--repo",
    repository,
    "--pattern",
    "manifest-entry.json",
    "--dir",
    tempDir,
  ]);

  const manifestPath = join(tempDir, "manifest-entry.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Array.isArray(manifest) ? manifest[0] : manifest;
}

function readChecksumAsset(repository, release, assetName, tempDir) {
  gh([
    "release",
    "download",
    release.tagName,
    "--repo",
    repository,
    "--pattern",
    assetName,
    "--dir",
    tempDir,
  ]);

  return readFileSync(join(tempDir, assetName), "utf8").trim().split(/\s+/)[0];
}

function fallbackManifestEntry(repository, release, buildYaml) {
  const zipAsset = release.assets.find((asset) => asset.name.endsWith(".zip"));
  if (!zipAsset) {
    throw new Error(`${release.tagName} has no zip asset`);
  }

  const checksumAssetName = `${zipAsset.name}.md5`;
  if (!release.assets.some((asset) => asset.name === checksumAssetName)) {
    throw new Error(`${release.tagName} has no ${checksumAssetName} asset`);
  }

  const versionMatch = zipAsset.name.match(/([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
  const version = versionMatch?.[1] ?? release.tagName.replace(/^v/, "");
  const tempDir = mkdtempSync(join(tmpdir(), "sso-release-"));

  try {
    return {
      ...pluginMetadata(buildYaml),
      versions: [
        {
          changelog: "",
          checksum: readChecksumAsset(repository, release, checksumAssetName, tempDir),
          sourceUrl: releaseAssetUrl(repository, release.tagName, zipAsset.name),
          targetAbi: scalar(buildYaml, "targetAbi"),
          timestamp: release.publishedAt,
          version,
        },
      ],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function releaseManifestEntry(repository, release, buildYaml) {
  const tempDir = mkdtempSync(join(tmpdir(), "sso-release-"));

  try {
    const entry =
      loadManifestEntryAsset(repository, release, tempDir) ??
      fallbackManifestEntry(repository, release, buildYaml);

    if (!entry?.versions?.[0]) {
      throw new Error(`${release.tagName} has no manifest version metadata`);
    }

    const version = {
      ...entry.versions[0],
      changelog: release.body || entry.versions[0].changelog || "",
      timestamp: release.publishedAt || entry.versions[0].timestamp,
    };

    return {
      category: entry.category,
      description: entry.description,
      guid: entry.guid,
      name: entry.name,
      overview: entry.overview,
      owner: entry.owner,
      versions: [version],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function versionParts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionsDesc(left, right) {
  const leftParts = versionParts(left.version);
  const rightParts = versionParts(right.version);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function repositoryManifest(entries) {
  const availableEntries = entries.filter(Boolean);
  if (availableEntries.length === 0) {
    return [];
  }

  const latest = availableEntries[0];
  const versions = availableEntries
    .flatMap((entry) => entry.versions)
    .sort(compareVersionsDesc);

  return [
    {
      category: latest.category,
      description: latest.description,
      guid: latest.guid,
      name: latest.name,
      overview: latest.overview,
      owner: latest.owner,
      versions,
    },
  ];
}

function htmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writeManifest(pagesDir, manifestPath, manifest) {
  const path = join(pagesDir, manifestPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

function writeIndex(pagesDir, title) {
  const manifestLinks = [
    ["manifest.json", "Stable repository manifest"],
    ["nightly/manifest.json", "Nightly repository manifest"],
  ].filter(([path]) => existsSync(join(pagesDir, path)));
  const manifestItems = manifestLinks
    .map(([path, label]) => `      <li><a href="${path}">${label}</a></li>`)
    .join("\n");

  writeFileSync(
    join(pagesDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${htmlEscape(title)}</title>
  </head>
  <body>
    <h1>${htmlEscape(title)}</h1>
    <ul>
${manifestItems}
    </ul>
  </body>
</html>
`,
  );
}

function buildPages() {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const buildYamlPath = process.env.BUILD_YAML ?? "build.yaml";
  const pagesDir = process.env.PAGES_DIR ?? "pages";
  const stableManifestPath = process.env.STABLE_MANIFEST_PATH ?? "manifest.json";
  const nightlyManifestPath =
    process.env.NIGHTLY_MANIFEST_PATH ?? "nightly/manifest.json";
  const buildYaml = readFileSync(buildYamlPath, "utf8");

  mkdirSync(pagesDir, { recursive: true });

  const stableEntries = listStableReleases(repository)
    .map((release) => viewRelease(repository, release.tagName))
    .filter((release) => release && !release.isDraft && !release.isPrerelease)
    .map((release) => releaseManifestEntry(repository, release, buildYaml));
  const stableManifest = repositoryManifest(stableEntries);
  writeManifest(pagesDir, stableManifestPath, stableManifest);

  const nightlyRelease = viewRelease(repository, "nightly", { optional: true });
  const nightlyEntries =
    nightlyRelease && !nightlyRelease.isDraft
      ? [releaseManifestEntry(repository, nightlyRelease, buildYaml)]
      : [];
  const nightlyManifest = repositoryManifest(nightlyEntries);
  writeManifest(pagesDir, nightlyManifestPath, nightlyManifest);

  const title =
    stableManifest[0]?.name ?? nightlyManifest[0]?.name ?? scalar(buildYaml, "name");
  writeIndex(pagesDir, title);
}

switch (command) {
  case "patch-build-yaml":
    patchBuildYaml();
    break;
  case "prepare-release":
    prepareReleaseAssets();
    break;
  case "build-pages":
    buildPages();
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
