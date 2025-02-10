import { DirectClient } from "@elizaos/client-direct";
import {
  elizaLogger,
  AgentRuntime,
  settings,
  stringToUuid,
  type Character,
  validateCharacterConfig,
  generateImage,
  generateCaption,
} from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { createNodePlugin } from "@elizaos/plugin-node";
import { solanaPlugin } from "@elizaos/plugin-solana";
import fs from "fs";
import net from "net";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import { initializeDbCache } from "./cache/index.ts";
import { character } from "./base-characters/character.ts";
import { initializeClients } from "./clients/index.ts";
import {
  getTokenForProvider,
  loadCharacters,
  parseArguments,
} from "./config/index.ts";
import { initializeDatabase } from "./database/index.ts";
import { heuristCharacter } from "./base-characters/heurist.character.ts";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

var storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.body.userId;
    const uploadDir = path.resolve(__dirname, `../data/${userId}`);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
var upload = multer({
  storage
  /*: multer.memoryStorage() */
});

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

let nodePlugin: any | undefined;
let heuristAgent: AgentRuntime | null = null;

function tryReadFolder(folderPath: string) {
  try {
    return fs.readdirSync(folderPath);
  } catch (e) {
    return null;
  }
}

function tryCreateFolder(folderPath: string) {
  try {
    if (!fs.existsSync(folderPath)){
      fs.mkdirSync(folderPath);
    }
  } catch (e) {
    return null;
  }
}

function tryWriteFile(filePath: string, content: string): string | null {
  try {
    fs.writeFile(filePath, content, 'utf8', () => {});
    return filePath;
  } catch (e) {
    return null;
  }
}

function tryLoadFile(filePath: string): string | null {
  try {
      return fs.readFileSync(filePath, "utf8");
  } catch (e) {
      return null;
  }
}
function mergeCharacters(base: Character, child: Character): Character {
  const mergeObjects = (baseObj: any, childObj: any) => {
      const result: any = {};
      const keys = new Set([
          ...Object.keys(baseObj || {}),
          ...Object.keys(childObj || {}),
      ]);
      keys.forEach((key) => {
          if (
              typeof baseObj[key] === "object" &&
              typeof childObj[key] === "object" &&
              !Array.isArray(baseObj[key]) &&
              !Array.isArray(childObj[key])
          ) {
              result[key] = mergeObjects(baseObj[key], childObj[key]);
          } else if (
              Array.isArray(baseObj[key]) ||
              Array.isArray(childObj[key])
          ) {
              result[key] = [
                  ...(baseObj[key] || []),
                  ...(childObj[key] || []),
              ];
          } else {
              result[key] =
                  childObj[key] !== undefined ? childObj[key] : baseObj[key];
          }
      });
      return result;
  };
  return mergeObjects(base, child);
}
async function handlePluginImporting(plugins: string[]) {
  if (plugins.length > 0) {
      elizaLogger.info("Plugins are: ", plugins);
      const importedPlugins = await Promise.all(
          plugins.map(async (plugin) => {
              try {
                  const importedPlugin = await import(plugin);
                  const functionName =
                      plugin
                          .replace("@elizaos/plugin-", "")
                          .replace(/-./g, (x) => x[1].toUpperCase()) +
                      "Plugin"; // Assumes plugin function is camelCased with Plugin suffix
                  return (
                      importedPlugin.default || importedPlugin[functionName]
                  );
              } catch (importError) {
                  elizaLogger.error(
                      `Failed to import plugin: ${plugin}`,
                      importError
                  );
                  return []; // Return null for failed imports
              }
          })
      );
      return importedPlugins;
  } else {
      return [];
  }
}

async function jsonToCharacter(
  filePath: string,
  character: any
): Promise<Character> {
  validateCharacterConfig(character);

  // .id isn't really valid
  const characterId = character.id || character.name;
  const characterPrefix = `CHARACTER.${characterId
      .toUpperCase()
      .replace(/ /g, "_")}.`;
  const characterSettings = Object.entries(process.env)
      .filter(([key]) => key.startsWith(characterPrefix))
      .reduce((settings, [key, value]) => {
          const settingKey = key.slice(characterPrefix.length);
          return { ...settings, [settingKey]: value };
      }, {});
  if (Object.keys(characterSettings).length > 0) {
      character.settings = character.settings || {};
      character.settings.secrets = {
          ...characterSettings,
          ...character.settings.secrets,
      };
  }
  // Handle plugins
  character.plugins = await handlePluginImporting(character.plugins);
  if (character.extends) {
      elizaLogger.info(
          `Merging  ${character.name} character with parent characters`
      );
      for (const extendPath of character.extends) {
          const baseCharacter = await loadCharacter(
              path.resolve(path.dirname(filePath), extendPath)
          );
          character = mergeCharacters(baseCharacter, character);
          elizaLogger.info(
              `Merged ${character.name} with ${baseCharacter.name}`
          );
      }
  }
  return character;
}

async function loadCharacter(filePath: string): Promise<Character> {
  const content = tryLoadFile(filePath);
  if (!content) {
      throw new Error(`Character file not found: ${filePath}`);
  }
  const character = JSON.parse(content);
  return jsonToCharacter(filePath, character);
}

async function loadCharacterTryPath(characterPath: string): Promise<Character> {
  let content: string | null = null;
  let resolvedPath = "";

  // Try different path resolutions in order
  const pathsToTry = [
      characterPath, // exact path as specified
      path.resolve(process.cwd(), characterPath), // relative to cwd
      path.resolve(process.cwd(), "agent", characterPath), // Add this
      path.resolve(__dirname, characterPath), // relative to current script
      path.resolve(__dirname, "characters", path.basename(characterPath)), // relative to agent/characters
      path.resolve(__dirname, "../characters", path.basename(characterPath)), // relative to characters dir from agent
      path.resolve(
          __dirname,
          "../../characters",
          path.basename(characterPath)
      ), // relative to project root characters dir
  ];

  elizaLogger.info(
      "Trying paths:",
      pathsToTry.map((p) => ({
          path: p,
          exists: fs.existsSync(p),
      }))
  );

  for (const tryPath of pathsToTry) {
      content = tryLoadFile(tryPath);
      if (content !== null) {
          resolvedPath = tryPath;
          break;
      }
  }

  if (content === null) {
      elizaLogger.error(
          `Error loading character from ${characterPath}: File not found in any of the expected locations`
      );
      elizaLogger.error("Tried the following paths:");
      pathsToTry.forEach((p) => elizaLogger.error(` - ${p}`));
      throw new Error(
          `Error loading character from ${characterPath}: File not found in any of the expected locations`
      );
  }
  try {
      const character: Character = await loadCharacter(resolvedPath);
      elizaLogger.info(`Successfully loaded character from: ${resolvedPath}`);
      return character;
  } catch (e) {
      elizaLogger.error(`Error parsing character from ${resolvedPath}: ${e}`);
      throw new Error(`Error parsing character from ${resolvedPath}: ${e}`);
  }
}

export function createAgent(
  character: Character,
  db: any,
  cache: any,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name,
  );

  nodePlugin ??= createNodePlugin();

  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [
      bootstrapPlugin,
      nodePlugin,
      character.settings?.secrets?.WALLET_PUBLIC_KEY ? solanaPlugin : null,
    ].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

async function startAgent(character: Character, directClient: DirectClient) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase();

    await db.init();

    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    runtime.clients = await initializeClients(character, runtime);

    directClient.registerAgent(runtime);

    // report to elizaLogger
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error,
    );
    elizaLogger.error(error);
    throw error;
  }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
};

const randomString = (length) => {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;
  let counter = 0;
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
    counter += 1;
  }
  return result;
}

const createCharacterJson = (folderPath: string) => {
  const files = tryReadFolder(folderPath);
  const knowledge = files.map((file) => {
    return {
      path: path.resolve(folderPath, file),
      shared: true
    }
  });

  character.knowledge = knowledge;
  const characterFolder = path.resolve(__dirname, "../characters");
  tryWriteFile(path.resolve(characterFolder, "temp.character.json"), JSON.stringify(character))
}

async function startHeuristAgent(character: Character) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase();

    await db.init();

    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    // report to elizaLogger
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error,
    );
    elizaLogger.error(error);
    throw error;
  }
}

const startAgents = async () => {
  const directClient = new DirectClient();
  let serverPort = parseInt(settings.SERVER_PORT || "3000");
  const args = parseArguments();

  let charactersArg = args.characters || args.character;
  // let characters = [character];
  let characters = [];

  elizaLogger.log("charactersArg", charactersArg);
  if (charactersArg) {
    characters = await loadCharacters(charactersArg);
  }
  elizaLogger.log("characters", characters);
  try {
    for (const character of characters) {
      await startAgent(character, directClient as DirectClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
  }

  while (!(await checkPortAvailable(serverPort))) {
    elizaLogger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
    serverPort++;
  }

  // start Heurist Agent to generate image
  heuristAgent = await startHeuristAgent(heuristCharacter);

  const prompts = [
    {
      id: "first",
      header: "Name",
      steps: [
        {
          title: "What should we call your $agent?",
          description: "",
          request: [
            {
              type: "text",
              single: false,
            },
          ],
          nextAction: [
            {
              type: "api",
              endpoint: "/newAgent",
              method: "post",
              params: [
                {
                  field: "promptId",
                  value: "first",
                  required: true,
                  type: "string",
                },
                {
                  field: "userId",
                  required: true,
                  type: "string",
                },
                {
                  field: "text",
                  required: true,
                  type: "string",
                },
              ],
            },
            {
              type: "nextPrompt",
            }
          ]
        }
      ]
    },
    {
      id: "second",
      header: "Description",
      steps: [
        {
          title: "Tell me a bit about $agent",
          description: "What’s it’s gender? Is it friendly or shy? What’s its purpose? Describe its personality. Likes/dislikes. Celebrity or figures that its most like? Be as detailed as you can for best results!",
          request: [
            {
              type: "text",
              single: false,
            },
          ],
          nextAction: [
            {
              type: "api",
              endpoint: "/newAgent",
              method: "post",
              params: [
                {
                  field: "promptId",
                  value: "second",
                  required: true,
                  type: "string",
                },
                {
                  field: "userId",
                  required: true,
                  type: "string",
                },
                {
                  field: "text",
                  required: true,
                  type: "string",
                },
              ],
            },
            {
              type: "nextPrompt",
            }
          ]
        }
      ]
    },
    {
      id: "third",
      header: "Knowledge",
      steps: [
        {
          title: "Let’s give $agent the gift of knowledge",
          description: "Import URL link or Upload some files for it to learn and build a knowledge base",
          request: [
            {
              type: "text",
              single: false,
            },
            {
              type: "file",
              single: false,
            }
          ],
          nextAction: [
            {
              type: "api",
              endpoint: "/newAgent",
              method: "post",
              params: [
                {
                  field: "promptId",
                  value: "third",
                  required: true,
                  type: "string",
                },
                {
                  field: "userId",
                  required: true,
                  type: "string",
                },
                {
                  field: "text",
                  required: false,
                  type: "string",
                },
                {
                  field: "file",
                  required: false,
                  type: "file",
                },
              ],
            },
            {
              type: "nextPrompt",
            }
          ]
        }
      ]
    },
    {
      id: "fourth",
      header: "NFT Image",
      steps: [
        {
          title: "Let’s give $agent a face",
          description: "Upload an image or create your own by writing prompt to generate the image.",
          request: [
            {
              type: "text",
              single: true,
            },
            {
              type: "file",
              single: true,
            }
          ],
          nextAction: [
            {
              type: "api",
              endpoint: "/newAgent",
              method: "post",
              params: [
                {
                  field: "promptId",
                  value: "fourth",
                  required: true,
                  type: "string",
                },
                {
                  field: "userId",
                  required: true,
                  type: "string",
                },
                {
                  field: "text",
                  required: false,
                  type: "string",
                },
                {
                  field: "file",
                  required: false,
                  type: "file",
                },
                {
                  field: "action",
                  value: "generateImage",
                  required: true,
                  type: "string"
                }
              ],
            },
            {
              type: "nextPrompt",
            }
          ]
        },
        {
          title: "",
          description: "Beautiful! Are you happy with how $agent looks?",
          request: [
            {
              type: "action",
              single: false,
            }
          ],
          nextAction: [
            {
              type: "nextPrompt",
            }
          ]
        },
      ]
    },
    {
      id: "fifth",
      header: "Agent Overview",
      steps: [
        {
          title: "Here’s what $agent is like",
          description: "is there anything you’d like me to change?",
          request: [
            {
              type: "action",
              single: false,
            }
          ],
          nextAction: [
            {
              type: "api",
              endpoint: "/newAgent",
              method: "post",
              params: [
                {
                  field: "promptId",
                  value: "fifth",
                  required: true,
                  type: "string",
                },
                {
                  field: "userId",
                  required: true,
                  type: "string",
                },
                {
                  field: "action",
                  value: "createAgent",
                  required: true,
                  type: "string"
                }
              ],
            },
          ]
        }
      ]
    },
  ]

  // API Endpoint for initial prompts
  directClient.app.get(
    "/initPrompts",
    async (req, res) => {
        const userId = stringToUuid(randomString(20) + new Date().getTime());  
        res.json({
          success: true,
          userId,
          prompts,
        });
    }
  );

  directClient.app.post(
    "/newAgent",
    upload.array("file"),
    async (req, res) => {
      let userId = req.body.userId;
      const folderPath = path.resolve(__dirname, `../data/${userId}`);
      const filePath = path.resolve(folderPath, `${userId}.json`);
      
      const prompt = prompts.find((item) => item.id == req.body.promptId);
      let content = {};
      const stringContent = tryLoadFile(filePath);
      if (stringContent) {
        content = JSON.parse(stringContent);
      }
      content[`${prompt.steps[0].title}`] = req.body.text;
      
      // create new folder for new agent data
      tryCreateFolder(folderPath);
      // write content to new json file
      tryWriteFile(filePath, JSON.stringify(content));

      if (req.body.action) {
        switch (req.body.action) {
          case "generateImage":
            const images = await generateImage({
              prompt: req.body.text,
              negativePrompt: "worst quality, low quality, blurry",
              width: 512,
              height: 512,
              count: 4,
              numIterations: 20,
              guidanceScale: 5,
              seed: -1,
            }, heuristAgent);
            const imagesRes = [];
            if (images.data && images.data.length > 0) {
              for (let i = 0; i < images.data.length; i++) {
                // const caption = await generateCaption(
                //   { imageUrl: images.data[i] },
                //   agent
                // );
                imagesRes.push({
                  image: images.data[i],
                  // caption: caption.title
                });
              }
            }
            res.json({
              success: true,
              images: imagesRes
            });
            break;
          case "createAgent":
            createCharacterJson(folderPath);
            character.id = userId;
            await directClient.startAgent(character);

            res.json({
              success: true,
              message: "Your agent is available at https://agentbento.com/agents/agantId",
              url: "https://agentbento.com/agents/agantId",
            });
          break;
          default:
            // return result with userId
            res.json({
              success: true,
              userId,
              content,
            });
            break;
        }
      } else {
        // return result with userId
        res.json({
          success: true,
          userId,
          content,
        });
      }
    }
  );

  // upload some agent functionality into directClient
  directClient.startAgent = async (character: Character) => {
    // wrap it so we don't have to inject directClient later
    return startAgent(character, directClient);
  };

  directClient.loadCharacterTryPath = loadCharacterTryPath;
  directClient.jsonToCharacter = jsonToCharacter;

  directClient.start(serverPort);

  if (serverPort !== parseInt(settings.SERVER_PORT || "3000")) {
    elizaLogger.log(`Server started on alternate port ${serverPort}`);
  }
};

startAgents().catch((error) => {
  elizaLogger.error("Unhandled error in startAgents:", error);
  process.exit(1);
});
