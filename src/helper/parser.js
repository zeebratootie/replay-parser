const fs = require('fs');
const ReplayParser = require("w3gjs/dist/lib/parsers/ReplayParser").default;
const W3GReplay = require("w3gjs/dist/lib/W3GReplay").default;

let itemData = null;
let itemById = null; // id -> item index, built lazily from itemData (O(1) lookups)

let TWRPG_HEROES = {};
let HERO_CLASSES = {};
const heroUrl = 'https://raw.githubusercontent.com/zeebratootie/twrpg-info/master/heros.json';
const heroFallbackUrl = 'https://raw.githubusercontent.com/sfarmani/twrpg-info/master/heros.json';

// Initialize item data
async function init(customItemDataPath = null) {
    itemById = null; // rebuilt lazily on first lookup after itemData is (re)loaded
    const defaultUrl = 'https://raw.githubusercontent.com/zeebratootie/twrpg-info/master/items.json';
    const fallbackUrl = 'https://raw.githubusercontent.com/sfarmani/twrpg-info/master/items.json';

    try {
        if (customItemDataPath) {
            itemData = JSON.parse(fs.readFileSync(customItemDataPath, 'utf8'));
        } else {
            const fetchItems = async (url) => {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`Item source fetch failed (${res.status} ${res.statusText})`);
                return res.json();
            };

            try {
                itemData = await fetchItems(defaultUrl);
            } catch (errPrimary) {
                console.warn('Primary items JSON fetch failed, trying fallback URL:', errPrimary.message);
                itemData = await fetchItems(fallbackUrl);
            }
        }

        let heroResponse;
        try {
            heroResponse = await fetch(heroUrl);
            if (!heroResponse.ok) throw new Error('Hero source fetch failed ' + heroResponse.statusText);
        } catch (err) {
            console.warn('Primary hero JSON fetch failed, trying fallback URL:', err.message);
            heroResponse = await fetch(heroFallbackUrl);
            if (!heroResponse.ok) throw new Error('Fallback hero source fetch failed ' + heroResponse.statusText);
        }

        const heroArray = await heroResponse.json();
        heroArray.forEach(h => {
            if (h.id && h.name) {
                TWRPG_HEROES[h.id.toUpperCase()] = h.name;
                if (h.heroClass) {
                    HERO_CLASSES[h.id.toUpperCase()] = h.heroClass;
                }
            }
        });

    } catch (error) {
        console.error('Error fetching or parsing item/hero data:', error);
    }
}


async function parseW3G(filepath, options = {}) {
    // debug=true returns the heavy extras (full w3gjs parse, w3gRaw, rawActionLog,
    // itemActions). The batch client never reads them, so they are skipped by
    // default — this is the main throughput win (11MB response -> ~35KB).
    const debug = !!options.debug;
    try {
        const buffer = fs.readFileSync(filepath);
        const parser = new ReplayParser();
        let time = 0; //ms
        let gameData = {};
        let playerData = {};
        let chat = [];
        let items = [];
        let purchases = [];
        let itemActions = [];
        let playerHeroes = {}; // Final hero per player (resolved after parse)
        let heroCodeCounts = {}; // playerId -> { HEROCODE: count }; the hero a player
                                 // references most in their own command blocks is theirs.
        let rawActionLog = []; // debug: catch-all for action IDs 16-20

        parser.on("basic_replay_information", (info) => {
            playerData = mapPlayerData(info.metadata.playerRecords, info.metadata.slotRecords)
            gameData = {
                version: info.subheader.version,
                length: msToReadableTime(info.subheader.replayLengthMS),
                map: info.metadata.map.mapName,
                host: info.metadata.map.creator,
                gameName: info.metadata.gameName
            };
        });

        parser.on("gamedatablock", (block) => {
            time += block.timeIncrement || 0;

            // user chat message
            if (block.id === 0x20) {
                const player = getPlayerById(playerData, block.playerId)
                chat.push({
                    timeMs: time,
                    time: msToReadableTime(time),
                    player: player.convertedName || player.playerName,
                    playerId: player.playerId,
                    color: player.hex,
                    mode: getMessageType(block.mode),
                    message: block.message
                });


                const extractedName = extractConvertName(block.message)
                if (extractedName !== null && extractedName !== player.playerName) {
                    player.convertedName = `${extractedName}(${player.playerName})`
                }

                // NOTE: we intentionally do NOT derive the hero from the -load
                // save code. The save code is an opaque hashed string; scanning it
                // for a 4-char hero id produced false matches (any hero code that
                // coincidentally appeared as a substring), which mis-tagged
                // players. The hero is now detected purely from in-game action
                // frequency (see heroCodeCounts below).
            }

            // user action
            if (block.commandBlocks && Array.isArray(block.commandBlocks) && block.commandBlocks.length === 0) {
                return;
            }

            if (block.id === 0x1f) {
                block.commandBlocks.forEach(commandBlock => {
                    const playerId = commandBlock.playerId;
                    
                    commandBlock.actions.forEach(action => {
                        // Frequency-based hero detection: count every reference to a
                        // valid hero unit code in THIS player's command blocks. A
                        // player issues orders to their own hero constantly, so the
                        // hero they reference most is their hero. This is robust
                        // against one-off global/shared events that previously
                        // mis-tagged a player from the first code seen.
                        const toHeroCode = (arr) => {
                            if (!Array.isArray(arr)) return null;
                            const code = convertBytesToFourCC(arr);
                            if (!code || !/^[A-Za-z0-9]{4}$/.test(code)) return null;
                            return code.toUpperCase();
                        };
                        const countHeroCode = (arr) => {
                            const upper = toHeroCode(arr);
                            if (upper && TWRPG_HEROES[upper] && upper !== 'HFOO') {
                                if (!heroCodeCounts[playerId]) heroCodeCounts[playerId] = {};
                                heroCodeCounts[playerId][upper] = (heroCodeCounts[playerId][upper] || 0) + 1;
                            }
                        };
                        countHeroCode(action.itemId);
                        countHeroCode(action.itemId1);
                        countHeroCode(action.itemId2);
                        if (Array.isArray(action.actions)) {
                            action.actions.forEach(sub => {
                                countHeroCode(sub.itemId1);
                                countHeroCode(sub.itemId2);
                            });
                        }

                        // Collect any item-related action IDs for this player
                        const resolveHeroName = (unitId) => {
                            if (!unitId || typeof unitId !== 'string') return null;
                            const normalized = unitId.toUpperCase();

                            if (TWRPG_HEROES[normalized]) {
                                return TWRPG_HEROES[normalized];
                            }

                            if (itemData) {
                                const entry = itemData.find(i => i.id && (i.id.toUpperCase() === normalized || i.id.toLowerCase() === unitId.toLowerCase()));
                                if (entry && entry.name) {
                                    return entry.name;
                                }
                            }

                            return null;
                        };

                        const collectItemAction = (fieldName, itemVal) => {
                            if (!itemVal || !Array.isArray(itemVal)) return;
                            if (!isAlphabetOrDigit(itemVal)) return;

                            const itemId = convertToAscii(itemVal);

                            itemActions.push({
                                time: time,
                                playerId: playerId,
                                actionId: action.id,
                                field: fieldName,
                                itemId: itemId
                            });
                            // (Hero detection happens via frequency counting above,
                            // not from individual item-action codes.)
                        };

                        collectItemAction('itemId', action.itemId);
                        collectItemAction('itemId1', action.itemId1);
                        collectItemAction('itemId2', action.itemId2);

                        // Debug: catch-all for ALL action types that carry item/unit fields
                        // Expanded beyond 16-20 to catch: 0x13 (give item), 0x1C (pick up ground item), 0x16 (selection)
                        // Only built when debug is requested — the per-action decode below is
                        // pure overhead for the batch client, which never reads rawActionLog.
                        if (debug) {
                            const NUMERIC_ABILITY_NAMES = {
                                '0x03 0x00 0x0d 0x00': 'right-click',
                                '0x04 0x00 0x0d 0x00': 'stop',
                                '0x08 0x00 0x0d 0x00': 'cancel',
                                '0x0f 0x00 0x0d 0x00': 'attack',
                                '0x12 0x00 0x0d 0x00': 'move',
                                '0x3b 0x00 0x0d 0x00': 'revive hero',
                            };
                            const decodeField = (arr) => {
                                if (!arr || !Array.isArray(arr)) return null;
                                if (isAlphabetOrDigit(arr)) {
                                    const fourcc = convertBytesToFourCC(arr);
                                    const itemName = itemData?.find(i => i.id === fourcc)?.name || null;
                                    const heroName = TWRPG_HEROES[fourcc.toUpperCase()] || null;
                                    const resolvedName = itemName || heroName;
                                    return resolvedName ? `${fourcc} — ${resolvedName}` : fourcc;
                                }
                                const hexKey = arr.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
                                return NUMERIC_ABILITY_NAMES[hexKey] || hexKey;
                            };

                            const decodedItemId  = decodeField(action.itemId);
                            const decodedItemId1 = decodeField(action.itemId1);
                            const decodedItemId2 = decodeField(action.itemId2);

                            // Only log if:
                            // - it's a 0x10-0x14 action with non-zero flags, OR
                            // - it's any other action that has at least one FourCC-resolvable item field
                            const isAbilityAction = action.id >= 16 && action.id <= 20 && action.abilityFlags !== 0;
                            const hasFourCC = [decodedItemId, decodedItemId1, decodedItemId2]
                                .some(v => v && !v.startsWith('0x') && !v.startsWith('['));

                            if (isAbilityAction || hasFourCC) {
                                rawActionLog.push({
                                    time: time,
                                    timeReadable: msToReadableTime(time),
                                    playerId: playerId,
                                    actionId: action.id,
                                    actionIdHex: `0x${action.id.toString(16).toUpperCase()}`,
                                    abilityFlags: action.abilityFlags,
                                    abilityFlagsHex: action.abilityFlags != null ? `0x${action.abilityFlags.toString(16).toUpperCase()}` : null,
                                    itemId: decodedItemId,
                                    itemId1: decodedItemId1,
                                    itemId2: decodedItemId2,
                                });
                            }
                        }

                        // Track loot drops (0x10 + 0x40: trigger/chest item grant)
                        if (action.id === 16 && action.abilityFlags === 64 && isAlphabetOrDigit(action.itemId)) {
                            const newItem = {
                                time: time,
                                playerId: playerId,
                                itemId: convertToAscii(action.itemId)
                            };
                            items.push(newItem);
                        }

                        // Track shop purchases / craft events (0x42=66 inventory use/skill, 0x44=68 summon/buy from shop)
                        // 0x40 (64) is excluded here — it's already tracked in the loots array above
                        if (action.id === 16 && (action.abilityFlags === 66 || action.abilityFlags === 68) && Array.isArray(action.itemId) && isAlphabetOrDigit(action.itemId)) {
                            purchases.push({
                                time: time,
                                playerId: playerId,
                                itemId: convertToAscii(action.itemId)
                            });
                        }
                    });
                });
            }
        });

        await parser.parse(buffer);

        // optained loots from chest
        const loots = items.map((item) => {
            try {
                const player = getPlayerById(playerData, item.playerId)
                const loot = {
                    gameTime: msToReadableTime(item.time),
                    playerName: player.convertedName || player.playerName,
                    itemName: getItemNameById(item.itemId)
                };

                return loot;
            } catch (error) {
                return null; // or handle the error in some other way
            }
        }).filter(entry => entry !== null);

        // Remove duplicates using Set
        const uniqueloots = [...new Set(loots)];

        // Map purchase events to readable format
        const purchaseResults = purchases.map((item) => {
            try {
                const player = getPlayerById(playerData, item.playerId);
                return {
                    gameTime: msToReadableTime(item.time),
                    playerName: player.convertedName || player.playerName,
                    itemName: getItemNameById(item.itemId),
                    playerColor: player.hex
                };
            } catch {
                return null;
            }
        }).filter(e => e !== null);

        // Resolve each player's hero: the hero code they referenced MOST in their
        // own command blocks. A player commands their own hero far more than any
        // stray code, so this is robust. If no hero codes were counted for a
        // player, they get no hero (the consumer falls back to other signals).
        Object.keys(heroCodeCounts).forEach(playerId => {
            const ranked = Object.entries(heroCodeCounts[playerId]).sort((a, b) => b[1] - a[1]);
            if (ranked.length > 0) {
                const [code, count] = ranked[0];
                playerHeroes[playerId] = {
                    code: code,
                    name: TWRPG_HEROES[code],
                    count: count,
                    source: 'action_frequency'
                };
            }
        });

        // Merge hero data into playerData, attaching the hero's class
        const playerDataWithHeroes = playerData.map(player => {
            const hero = playerHeroes[player.playerId] || null;
            if (hero && hero.code) {
                hero.heroClass = HERO_CLASSES[hero.code.toUpperCase()] || null;
            }
            return { ...player, hero };
        });


        // Craft events (experimental): I0N2 / I00L are the in-game craft-menu
        // items. Their use means a player opened the crafting menu. NOTE: the
        // replay does not record the crafted RESULT item (it's computed in-game
        // from inventory through a multi-step menu), so this only reports that a
        // craft menu was opened, by whom and when.
        const CRAFT_ITEM_CODES = ['I0N2', 'I00L'];
        const craftEvents = (itemActions || [])
            .filter(a => CRAFT_ITEM_CODES.includes(a.itemId))
            .map(a => {
                const player = getPlayerById(playerData, a.playerId);
                return {
                    time: a.time,
                    gameTime: msToReadableTime(a.time),
                    playerName: (player && (player.convertedName || player.playerName)) || `Player ${a.playerId}`,
                    craftCode: a.itemId
                };
            });

        // Lean response by default — this is everything the batch client reads.
        const result = {
            gameData: gameData,
            playerData: playerDataWithHeroes,
            chatData: chat,
            loots: uniqueloots,
            purchases: purchaseResults,
            craftEvents: craftEvents
        };

        // Heavy extras only on ?debug=1. This second full w3gjs parse plus the
        // multi-MB w3gRaw/rawActionLog/itemActions payload is the bulk of the
        // per-file cost and is unused by the batch client.
        if (debug) {
            const w3gReplay = new W3GReplay();
            await w3gReplay.parse(buffer);

            result.playerData = playerDataWithHeroes.map(player => {
                const w3gPlayer = w3gReplay.players[player.playerId];
                const w3gItems = w3gPlayer
                    ? Object.entries(w3gPlayer.items.summary || {}).map(([id, count]) => ({
                        itemId: id,
                        count,
                        itemName: itemData && itemData.find(i => i.id === id)?.name || null
                    }))
                    : [];
                const w3gHeroCodes = w3gPlayer ? Object.keys(w3gPlayer.heroCollector || {}) : [];
                const w3gHeroes = w3gHeroCodes.map(code => ({
                    code,
                    name: TWRPG_HEROES[code.toUpperCase()] || null
                }));
                return { ...player, w3gItems, w3gHeroes };
            });

            result.itemActions = itemActions;
            result.rawActionLog = rawActionLog;
            result.w3gRaw = {
                info: w3gReplay.info,
                players: w3gReplay.players,
                playerList: w3gReplay.playerList,
                slots: w3gReplay.slots,
                chatlog: w3gReplay.chatlog,
                w3mmd: w3gReplay.w3mmd,
                leaveEvents: w3gReplay.leaveEvents,
                actionsByPlayer: Object.keys(w3gReplay.players).reduce((acc, playerId) => {
                    const pl = w3gReplay.players[playerId];
                    acc[playerId] = {
                        id: pl.id,
                        name: pl.name,
                        race: pl.race,
                        apm: pl.apm,
                        units: pl.units,
                        items: pl.items,
                        heroes: pl.heroCollector,
                        actions: pl.actions
                    };
                    return acc;
                }, {})
            };
        }

        return result;
    } catch (error) {
        throw error;
    }
}

function isAlphabetOrDigit(asciiValues) {
    return asciiValues.every(value => (value >= 48 && value <= 122));
}

function msToReadableTime(milliseconds) {
    let remainingMs = milliseconds;

    const hours = Math.floor(remainingMs / 3600000);
    remainingMs %= 3600000;

    const minutes = Math.floor(remainingMs / 60000);
    remainingMs %= 60000;

    const seconds = Math.floor(remainingMs / 1000);
    const padWithZero = (num) => (num < 10 ? '0' + num : num);

    const formattedTime = `${padWithZero(hours)}:${padWithZero(minutes)}:${padWithZero(seconds)}`;
    return formattedTime;
}

function convertToAscii(array) {
    return array.map(num => String.fromCharCode(num)).reverse().join('');
}

function convertBytesToFourCC(byteArray) {
    if (!byteArray || byteArray.length < 4) return 'UNKNOWN';
    return String.fromCharCode(byteArray[3], byteArray[2], byteArray[1], byteArray[0]);
}

function getItemNameById(id) {
    if (!itemData) {
        throw new Error('Item data not initialized. Please call init() first.');
    }
    if (!itemById) {
        itemById = new Map(itemData.map(i => [i.id, i]));
    }

    const item = itemById.get(id);
    if (!item) {
        throw new Error(`Item with id ${id} not found.`);
    }

    return item.name;
}

function getPlayerById(playerData, id) {
    const player = playerData.find(player => player.playerId === id);
    if (!player) {
        throw new Error(`Player with id ${id} not found.`);
    }

    return player;
}

// Function to map player data with id, name, and color details
function mapPlayerData(playerRecords, slotRecords) {

    const colors = [
        { id: 0, name: 'Red', hex: 'FF0303', rgb: [255, 3, 3] },
        { id: 1, name: 'Blue', hex: '0042FF', rgb: [0, 66, 255] },
        { id: 2, name: 'Teal', hex: '1CE6B9', rgb: [28, 230, 185] },
        { id: 3, name: 'Purple', hex: 'A64DFF', rgb: [166, 77, 255] },
        { id: 4, name: 'Yellow', hex: 'FFFF01', rgb: [255, 255, 1] },
        { id: 5, name: 'Orange', hex: 'FE8A0E', rgb: [254, 138, 14] },
        { id: 6, name: 'Green', hex: '20C000', rgb: [32, 192, 0] },
        { id: 7, name: 'Pink', hex: 'E55BB0', rgb: [229, 91, 176] },
        { id: 8, name: 'Grey', hex: '959697', rgb: [149, 150, 151] },
        { id: 9, name: 'Light Blue', hex: '7EBFF1', rgb: [126, 191, 241] },
        { id: 10, name: 'Dark Green', hex: '106246', rgb: [16, 98, 70] },
        { id: 11, name: 'Brown', hex: '4E2A04', rgb: [78, 42, 4] }
    ];

    // Create a mapping of playerId to playerName
    const playerMap = {};
    playerRecords.forEach(record => {
        playerMap[record.playerId] = record.playerName;
    });

    // Create the final mapping of player data with id, name, and color details, only for players
    const playerData = slotRecords
        .filter(slot => slot.playerId !== 0)
        .map(slot => {
            const color = colors.find(c => c.id === slot.color);
            return {
                playerId: slot.playerId,
                playerName: playerMap[slot.playerId] || 'Unknown',
                colorId: color ? color.id : 'Unknown',
                hex: color ? color.hex : 'Unknown',
                rgb: color ? color.rgb : 'Unknown'
            };
        });

    return playerData;
}

function getMessageType(code) {
    switch (code) {
        case 0x00:
            return "All";
        case 0x01:
            return "Allies";
        case 0x02:
            return "Observers";
        default:
            return "Direct Message";
    }
}

function extractConvertName(input) {
    const pattern = /^-convert\s+(.*)/;
    const match = input.match(pattern);
    if (match) {
        return match[1];
    }
    return null; // or return an appropriate value if the string does not start with -convert
}

module.exports = {
    init,
    parseW3G
};
