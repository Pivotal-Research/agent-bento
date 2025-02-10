import { Character, ModelProviderName } from "@elizaos/core";

export const character: Character = {
    id: null,
    name: "Temp",
    plugins: [],
    clients: [],
    modelProvider: ModelProviderName.ANTHROPIC,
    settings: {
        secrets: {},
        voice: {
            model: "en_US-hfc_female-medium",
        },
    },
    knowledge: [],
    bio: [],
    lore: [],
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
