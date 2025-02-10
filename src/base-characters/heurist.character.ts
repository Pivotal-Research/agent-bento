import { Character, ModelProviderName } from "@elizaos/core";

export const heuristCharacter: Character = {
    name: "Base Heurist Character",
    plugins: [],
    clients: [],
    modelProvider: ModelProviderName.HEURIST,
    settings: {
        secrets: {},
        voice: {
            model: "en_US-hfc_female-medium",
        },
    },
    system: "Generate profile image",
    bio: [],
    lore: [],
    knowledge: [],
    messageExamples: [],
    postExamples: [],
    adjectives: [],
    topics: [],
    style: {
        all: [],
        chat: [],
        post: [],
    },
};
