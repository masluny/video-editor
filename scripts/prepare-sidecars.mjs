import { chmodSync, copyFileSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const binDir = join(root, "src-tauri", "binaries");
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function hostTriple() {
  const output = commandOutput("rustc", ["-vV"]);
  const match = output.match(/^host: (.+)$/m);
  if (!match) throw new Error("Could not determine Rust host triple from rustc -vV.");
  return match[1];
}

function existingFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function removeExisting(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function findWindowsBinary(name) {
  const chocolateyRoot = process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey";
  const chocolateyBinary = join(chocolateyRoot, "lib", "ffmpeg", "tools", "ffmpeg", "bin", `${name}.exe`);
  if (existingFile(chocolateyBinary)) return chocolateyBinary;
  return commandOutput("where.exe", [`${name}.exe`]).split(/\r?\n/)[0];
}

function findUnixBinary(name) {
  return commandOutput("which", [name]).split(/\r?\n/)[0];
}

function findBinary(name) {
  const envName = `${name.toUpperCase()}_PATH`;
  if (process.env[envName] && existingFile(process.env[envName])) return process.env[envName];
  return isWindows ? findWindowsBinary(name) : findUnixBinary(name);
}

const target = hostTriple();
mkdirSync(binDir, { recursive: true });

for (const name of ["ffmpeg", "ffprobe"]) {
  const source = realpathSync(findBinary(name));
  const destination = join(binDir, `${name}-${target}${exe}`);
  mkdirSync(dirname(destination), { recursive: true });
  removeExisting(destination);
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  console.log(`Prepared ${name} sidecar for ${target}: ${destination}`);
}
