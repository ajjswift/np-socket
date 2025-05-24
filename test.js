import pty from "node-pty";
import fs from "fs";
import path from "path";

// Write the code to a temp file
const code = `
name = input("hello, what's your name? ")
if name == 'Alex':
  print("hello, that's my name too!")
else:
  print("Aw shucks, we don't have the same name.")
print("goodbye.")
`;

const tmpDir = "/tmp/nixpackpy";
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const filePath = path.join(tmpDir, "main.py");
fs.writeFileSync(filePath, code);

// Start a real PTY running Python
const shell = pty.spawn("python3", ["-u", filePath], {
  name: "xterm-color",
  cols: 80,
  rows: 30,
  cwd: tmpDir,
  env: process.env,
});

// Pipe PTY output to your terminal
shell.on("data", (data) => {
  process.stdout.write(data);
});

// Pipe your terminal input to the PTY
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  shell.write(data);
});

// When the process exits, exit this script
shell.on("exit", (code) => {
  console.log(`\n[Process exited with code ${code}]`);
  process.exit(code);
});
