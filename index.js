import { v4 as uuidv4 } from "uuid";
import { WebSocketServer } from "ws";
import { redis, get, set } from "./redis.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import ContainerSessionManager from "./ContainerSessionManager.js";
import { jwtVerify } from "jose";

const manager = new ContainerSessionManager();
const wss = new WebSocketServer({ port: 4987 });

wss.on("connection", async (ws, req) => {
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k, decodeURIComponent(v.join("="))];
    })
  );

  const token = cookies.session_token;

  if (!token) {
      ws.close(4001, "No session token");
      return;
  }

  try {
      const { payload } = await jwtVerify(
          token,
          new TextEncoder().encode(process.env.JWT_SECRET)
      );
      // Attach user info to ws for later use
      ws.user = payload;
  } catch (err) {
      console.error(err);
      ws.close(4002, "Invalid session token");
      return;
  }

  const sessionId = uuidv4();
  ws.sessionId = sessionId;
  ws.send(JSON.stringify({ event: "connected", data: { sessionId } }));

  ws.on("message", async (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      ws.send(
        JSON.stringify({
          event: "error",
          data: { message: "Invalid JSON", details: error.message },
        })
      );
      return;
    }

    if (!ws.sessionId) {
      ws.send(
        JSON.stringify({
          event: "error",
          data: { message: "No active session" },
        })
      );
      return;
    }

    try {
      await handleWebSocketMessage(ws, data);
    } catch (error) {
      ws.send(
        JSON.stringify({
          event: "error",
          data: { message: "Error processing request", details: error.message },
        })
      );
    }
  });

  ws.on("close", () => {
    if (ws.environmentId) {
      // Unregister client from its environment
      manager.unregisterClient(ws.environmentId, ws);
      
      // Notify other clients about cursor removal
      const message = JSON.stringify({
        event: "deleteCursor",
        data: { sessionId: ws.sessionId },
      });
  
      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === client.OPEN &&
          client.environmentId === ws.environmentId
        ) {
          client.send(message);
        }
      });
    }
  });
});

async function handleWebSocketMessage(ws, data) {
  const sessionId = ws.sessionId;

  switch (data.event) {
    case "getFiles": {
      const { environmentId } = data.data || {};
      if (!environmentId) {
        throw new Error("environmentId is required");
      }
      
      ws.environmentId = environmentId;
      // Register this client with the environment
      manager.registerClient(environmentId, ws);
      
      const files = await manager.getAllFilesForEnvironment(environmentId);
      console.log(files);
      ws.send(
        JSON.stringify({
          event: "files",
          data: { files },
        })
      );
      break;
    }
    
    case "diffLine": {
      const { environmentId, fileName, op, lineNumber, lineContent, count } = data.data || {};
    
      if (
        !environmentId ||
        !fileName ||
        typeof lineNumber !== "number" ||
        !["insert", "delete", "replace"].includes(op)
      ) {
        throw new Error("environmentId, fileName, op, and lineNumber are required");
      }
    
      const fileKey = `${environmentId}_${fileName}`;
      let fileContent = await get(fileKey) || "";
      let lines = fileContent.split("\n");
      let updates = [];
    
      if (op === "insert") {
        // lineContent should be an array of lines to insert
        const linesToInsert = Array.isArray(lineContent) ? lineContent : [lineContent];
        lines.splice(lineNumber, 0, ...linesToInsert);
        
        // Prepare updates for broadcast
        for (let i = 0; i < linesToInsert.length; i++) {
          updates.push({
            fileName,
            op: "insert",
            lineNumber: lineNumber + i,
            lineContent: linesToInsert[i],
          });
        }
      } else if (op === "delete") {
        // count: number of lines to delete (default 1)
        const deleteCount = typeof count === "number" && count > 0 ? count : 1;
        lines.splice(lineNumber, deleteCount);
        
        for (let i = 0; i < deleteCount; i++) {
          updates.push({
            fileName,
            op: "delete",
            lineNumber: lineNumber, // always the same, as lines shift up
            lineContent: null,
          });
        }
      } else if (op === "replace") {
        // lineContent should be an array of lines to replace
        const linesToReplace = Array.isArray(lineContent) ? lineContent : [lineContent];
        
        for (let i = 0; i < linesToReplace.length; i++) {
          if (lineNumber + i < lines.length) {
            lines[lineNumber + i] = linesToReplace[i];
            updates.push({
              fileName,
              op: "replace",
              lineNumber: lineNumber + i,
              lineContent: linesToReplace[i],
            });
          } else {
            // If out of range, treat as insert
            lines.splice(lineNumber + i, 0, linesToReplace[i]);
            updates.push({
              fileName,
              op: "insert",
              lineNumber: lineNumber + i,
              lineContent: linesToReplace[i],
            });
          }
        }
      }
    
      const newContent = lines.join("\n");
      await set(fileKey, newContent);
    
      // Broadcast all updates to other clients in the same environment
      updates.forEach((update) => {
        const message = JSON.stringify({
          event: "lineUpdated",
          data: update,
        });
        
        wss.clients.forEach((client) => {
          if (
            client !== ws &&
            client.readyState === client.OPEN &&
            client.environmentId === environmentId
          ) {
            client.send(message);
          }
        });
      });
      break;
    }
    
    case "run": {
      const { fileNames, environmentId, hash, files: clientFiles } = data.data || {};
      if (!Array.isArray(fileNames) || !environmentId) {
        throw new Error("fileNames (array) and environmentId are required");
      }
      
      const envId = ws.environmentId;
      const message = JSON.stringify({
        event: "runRan"
      });
      
      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === client.OPEN &&
          client.environmentId === envId
        ) {
          client.send(message);
        }
      });
      
      // Make sure client is registered with this environment
      if (ws.environmentId !== environmentId) {
        ws.environmentId = environmentId;
        manager.registerClient(environmentId, ws);
      }
      
      // Start a shared session for this environment (will kill any existing session)
      const success = await manager.startSession(environmentId, fileNames, hash, clientFiles);
      
      ws.send(
        JSON.stringify({ event: "runStatus", data: { success } })
      );
      break;
    }
    
    case "input": {
      if (!data.data || typeof data.data.input !== "string") {
        throw new Error("Input data is required");
      }
      
      // Send input to the environment's session, not the client's session
      const environmentId = ws.environmentId;
      if (!environmentId) {
        throw new Error("No active environment");
      }
      
      const ok = await manager.sendInput(environmentId, data.data.input);
      if (!ok) {
        throw new Error("Failed to send input");
      }
      break;
    }
    
    case "stop": {
      const environmentId = ws.environmentId;
      if (!environmentId) {
        throw new Error("No active environment");
      }
      
      const success = await manager.stopSession(environmentId);
      
      // Broadcast stop status to all clients in the environment
      const message = JSON.stringify({
        event: "stopped",
        data: { environmentId, success },
      });
      manager.broadcastToEnvironment(environmentId, message);
      break;
    }
    
    case "renameFile": {
      const { environmentId, oldName, newName } = data.data || {};
      if (!environmentId || !oldName || !newName) {
        throw new Error("environmentId, oldName, and newName are required");
      }
      
      await manager.renameFile(environmentId, oldName, newName);
      ws.send(
        JSON.stringify({
          event: "renameFileStatus",
          data: { success: true, oldName, newName },
        })
      );
      
      const files = await manager.getAllFilesForEnvironment(environmentId);
      
      // Broadcast updated files to all clients in the environment
      const message = JSON.stringify({
        event: "files",
        data: { files },
      });
      manager.broadcastToEnvironment(environmentId, message);
      break;
    }
    
    case "deleteFile": {
      const { environmentId, fileName } = data.data || {};
      if (!environmentId || !fileName) {
        throw new Error("environmentId and fileName are required");
      }
      
      await manager.deleteFile(environmentId, fileName);
      ws.send(
        JSON.stringify({
          event: "deleteFileStatus",
          data: { success: true, fileName },
        })
      );
      
      const files = await manager.getAllFilesForEnvironment(environmentId);
      
      // Broadcast updated files to all clients in the environment
      const message = JSON.stringify({
        event: "files",
        data: { files },
      });
      manager.broadcastToEnvironment(environmentId, message);
      break;
    }

    case "duplicateFile": {
      const { environmentId, fileName } = data.data || {};
      if (!environmentId || !fileName) {
        throw new Error("environmentId and fileName are required");
      }
      
      const newName = await manager.duplicateFile(environmentId, fileName);
      ws.send(
        JSON.stringify({
          event: "duplicateFileStatus",
          data: { success: true, oldName: fileName, newName },
        })
      );
      
      const files = await manager.getAllFilesForEnvironment(environmentId);
      
      // Broadcast updated files to all clients in the environment
      const message = JSON.stringify({
        event: "files",
        data: { files },
      });
      manager.broadcastToEnvironment(environmentId, message);
      break;
    }
    
    case "cursorMove": {
      const { line, ch, file: currentFile, environmentId } = data.data || {};
      const envId = environmentId || ws.environmentId;
      if (!envId) {
        throw new Error("environmentId is required for cursorMove");
      }
    
      ws.environmentId = envId;
    
      const message = JSON.stringify({
        event: "movedCursor",
        data: {
          id: sessionId,
          pos: { line, ch },
          file: currentFile,
        },
      });
    
      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === client.OPEN &&
          client.environmentId === envId
        ) {
          client.send(message);
        }
      });
      break;
    }

    case "inputChange": {
      const { input } = data.data || {};
      const envId = ws.environmentId;
      const message = JSON.stringify({
        event: "inputChanged",
        data: { input }
      });

      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === client.OPEN &&
          client.environmentId === envId
        ) {
          client.send(message);
        }
      });
      break;
    }
    
    default:
      throw new Error(`Unknown event: ${data.event}`);
  }
}

console.log("WebSocket PTY server running on port 4987");
