import { v4 as uuidv4 } from "uuid";
import { redis, get, set } from "./redis.js";
import pty from "node-pty";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

class ContainerSessionManager {
  constructor() {
    this.sessions = new Map(); // Maps environmentId -> session
    this.clientsMap = new Map(); // Maps environmentId -> Set of WebSocket clients
    this.baseTmpDir = path.join(os.tmpdir(), "nixpackpy");

    if (!fs.existsSync(this.baseTmpDir)) {
      fs.mkdirSync(this.baseTmpDir, { recursive: true });
    }
  }

  registerClient(environmentId, client) {
    if (!this.clientsMap.has(environmentId)) {
      this.clientsMap.set(environmentId, new Set());
    }
    this.clientsMap.get(environmentId).add(client);
  }

  unregisterClient(environmentId, client) {
    if (this.clientsMap.has(environmentId)) {
      this.clientsMap.get(environmentId).delete(client);

      // If no clients left, stop the session
      if (this.clientsMap.get(environmentId).size === 0) {
        this.stopSession(environmentId);
        this.clientsMap.delete(environmentId);
      }
    }
  }

  broadcastToEnvironment(environmentId, message) {
    if (this.clientsMap.has(environmentId)) {
      const clients = this.clientsMap.get(environmentId);
      clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
          client.send(message);
        }
      });
    }
  }

  async buildFileObject(fileNames, environmentId) {
    const filePromises = fileNames.map(async (fileName) => {
      const fileKey = `${environmentId}_${fileName}`;
      let fileContent = await get(fileKey);

      if (!fileContent && fileName === "main.py") {
        fileContent =
          'import time\nwhile True:\n print("hello world")\n time.sleep(1)';
      }




      return { fileName, fileContent: fileContent || "" };
    });

    const fileResults = await Promise.all(filePromises);
    let files = fileResults.reduce((acc, { fileName, fileContent }) => {
      acc[fileName] = fileContent;
      return acc;
    }, {});


    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex");

    return {files, hash};
  }

  async writeFilesToDir(environmentId, files) {
    const sessionDir = path.join(this.baseTmpDir, environmentId);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    for (const [fileName, fileContent] of Object.entries(files)) {
      fs.writeFileSync(path.join(sessionDir, fileName), fileContent);
    }

    return sessionDir;
  }

  async startSession(environmentId, fileNames, hash, clientFiles) {
    // Kill any existing session for this environment first
    if (this.sessions.has(environmentId)) {
      await this.stopSession(environmentId);

      // Notify clients that the previous session was stopped
      const stopMessage = JSON.stringify({
        event: "stopped",
        data: { environmentId, success: true, reason: "restarted" },
      });
      this.broadcastToEnvironment(environmentId, stopMessage);
    }

    try {
      const filesObj = await this.buildFileObject(fileNames, environmentId);
      let { files, hash: serverHash } = filesObj;
      const sessionDir = await this.writeFilesToDir(environmentId, files);
      const mainFile = fileNames.includes("main.py") ? "main.py" : fileNames[0];

      if (hash !== serverHash) {
        // Hash mismatch, so we need to use client files instead
        files = clientFiles;
      }

      // Build Docker run command
      const containerName = `nixpackpy_${environmentId}`;
      const dockerArgs = [
        "run",
        "--rm",
        "-it",
        "--name",
        containerName,
        "--network=none",
        "--memory=256m",
        "--cpus=0.5",
        "-v",
        `${sessionDir}:/workspace`,
        "-w",
        "/workspace",
        "python:3.9-slim",
        "python3",
        "-u",
        mainFile,
      ];

      // Spawn Docker process in a PTY
      const ptyProcess = pty.spawn("docker", dockerArgs, {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
      });

      ptyProcess.on("data", (data) => {
        const message = JSON.stringify({
          event: "output",
          data: { output: data },
        });
        this.broadcastToEnvironment(environmentId, message);
      });

      ptyProcess.on("exit", (code) => {
        const message = JSON.stringify({
          event: "exit",
          data: { exitCode: code },
        });
        this.broadcastToEnvironment(environmentId, message);
        this.sessions.delete(environmentId);
      });

      this.sessions.set(environmentId, {
        ptyProcess,
        sessionDir,
        containerName,
      });
      return true;
    } catch (error) {
      const errorMsg = `Error starting session: ${error.message}`;
      const outputMessage = JSON.stringify({
        event: "output",
        data: { output: errorMsg },
      });
      this.broadcastToEnvironment(environmentId, outputMessage);

      const exitMessage = JSON.stringify({
        event: "exit",
        data: { exitCode: 1 },
      });
      this.broadcastToEnvironment(environmentId, exitMessage);
      return false;
    }
  }

  async sendInput(environmentId, input) {
    const session = this.sessions.get(environmentId);
    if (!session) return false;

    try {
      session.ptyProcess.write(input.endsWith("\n") ? input : input + "\n");
      return true;
    } catch (error) {
      console.error(
        `Error sending input to environment ${environmentId}:`,
        error
      );
      return false;
    }
  }

  async renameFile(environmentId, oldName, newName) {
    const oldKey = `${environmentId}_${oldName}`;
    const newKey = `${environmentId}_${newName}`;
    const content = await get(oldKey);

    if (content === null || content === undefined) {
      throw new Error("File does not exist");
    }

    await set(newKey, content);
    await redis.del(oldKey);
    return true;
  }

  async deleteFile(environmentId, fileName) {
    const fileKey = `${environmentId}_${fileName}`;
    await redis.del(fileKey);
    return true;
  }

  async duplicateFile(environmentId, fileName) {
    const fileKey = `${environmentId}_${fileName}`;
    const content = await get(fileKey);

    if (content === null || content === undefined) {
      throw new Error("File does not exist");
    }

    // Determine new file name
    const extIndex = fileName.lastIndexOf(".");
    let newName;
    if (extIndex > 0) {
      newName =
        fileName.slice(0, extIndex) + "_copy" + fileName.slice(extIndex);
    } else {
      newName = fileName + "_copy";
    }

    const newKey = `${environmentId}_${newName}`;
    await set(newKey, content);
    return newName;
  }

  async stopSession(environmentId) {
    const session = this.sessions.get(environmentId);
    if (!session) return false;

    try {
      // Try to kill the docker container if still running
      // This is non-blocking; if the container is already gone, it's fine
      pty.spawn("docker", ["kill", session.containerName], {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
      });
      session.ptyProcess.kill();
      this.sessions.delete(environmentId);
      return true;
    } catch (error) {
      console.error(
        `Error stopping session for environment ${environmentId}:`,
        error
      );
      this.sessions.delete(environmentId);
      return false;
    }
  }

  async saveFile(environmentId, fileName, content) {
    const fileKey = `${environmentId}_${fileName}`;
    await set(fileKey, content);
    return true;
  }

  async getAllFilesForEnvironment(environmentId) {
    const pattern = `${environmentId}_*`;
    let cursor = "0";
    const files = {};

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = nextCursor;

      for (const key of keys) {
        const fileName = key.substring(environmentId.length + 1);
        files[fileName] = await get(key);
      }
    } while (cursor !== "0");

    return files;
  }
}

export default ContainerSessionManager;
