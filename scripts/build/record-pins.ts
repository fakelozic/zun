/**
 * zun (security: supply chain, SC-5): record the sha256 of new build downloads, without building anything.
 *
 *   bun scripts/build/record-pins.ts [--append] [--keep] <url>...
 *
 * For each URL: download it into a fresh private temp dir (mkdtemp, mode 0700; the file is created with O_EXCL), hash
 * it and print `<sha256>  <url>`, the format of scripts/build/deps/sha256sums.txt. With `--append` the line is added to
 * that file; without it, nothing in the repo changes. With `--keep` the downloaded file is kept for inspection and its
 * path printed; otherwise it is deleted.
 *
 * This is trust-on-first-use. Before committing a pin, cross-check it against an independent source (GitHub's release
 * asset digest, nodejs.org SHASUMS256.txt, a second download from another network) and review the diff. The build
 * itself (download.ts) only ever *checks* pins: an unpinned URL stops it before any network access.
 *
 * A URL that already has a pin is not re-recorded: the existing pin is compared with a fresh download and a mismatch is
 * reported (exit 1). Changing a pin is a manual edit, so that it shows up as one in review.
 */

import { appendFileSync, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadable } from "node:stream/web";
import { pinnedSha256, sha256File, sha256SumsFile } from "./download.ts";

const USAGE = "usage: bun scripts/build/record-pins.ts [--append] [--keep] <https-url>...\n";

async function main(argv: string[]): Promise<number> {
  const append = argv.includes("--append");
  const keep = argv.includes("--keep");
  const urls = argv.filter(a => !a.startsWith("--"));
  const unknown = argv.filter(a => a.startsWith("--") && a !== "--append" && a !== "--keep");
  if (urls.length === 0 || unknown.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }

  let failed = false;
  for (const url of urls) {
    // Only https: the pin is trust-on-first-use, so at least the first use must be authenticated transport.
    // (Also keeps whitespace and other oddities out of sha256sums.txt, whose format is `<sha>  <url-without-spaces>`.)
    if (!/^https:\/\/\S+$/.test(url)) {
      console.error(`refusing ${JSON.stringify(url)}: only https:// URLs without whitespace can be pinned`);
      failed = true;
      continue;
    }

    const dir = await mkdtemp(join(tmpdir(), "zun-record-pin-"));
    const file = join(dir, "download");
    try {
      const res = await fetch(url, { headers: { "User-Agent": "bun-build-system" } });
      if (!res.ok || res.body === null) {
        console.error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        failed = true;
        continue;
      }
      // flags "wx": O_CREAT|O_EXCL, so we never write through a file or symlink someone else put there.
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeWebReadable),
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
      const sha = await sha256File(file);
      const line = `${sha}  ${url}`;

      const existing = pinnedSha256(url);
      if (existing !== undefined) {
        if (existing === sha) console.log(`already pinned, matches: ${line}`);
        else {
          console.error(`MISMATCH for ${url}: pinned ${existing}, downloaded ${sha}. Not changing the pin.`);
          failed = true;
        }
      } else if (append) {
        appendFileSync(sha256SumsFile, line + "\n");
        console.log(`appended to ${sha256SumsFile}: ${line}`);
      } else {
        console.log(line);
      }
      if (keep) console.log(`  kept: ${file}`);
    } catch (err) {
      console.error(`failed to record ${url}: ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
    } finally {
      if (!keep) await rm(dir, { recursive: true, force: true });
    }
  }
  if (append && !failed) console.log("Now cross-check each sha256 independently and review `git diff` before committing.");
  return failed ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
