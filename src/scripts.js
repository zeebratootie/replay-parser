document.getElementById('uploadForm').addEventListener('submit', async function (event) {
    event.preventDefault();

    const files = document.getElementById('fileInput').files;
    const username = document.getElementById('usernameInput').value;
    const mapname = document.getElementById('mapnameInput').value;
    const message = document.getElementById('messageInput').value;
    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = ''; // Clear previous results
    document.documentElement.style.cursor = 'wait';

    const uploadPromises = Array.from(files).map((file, index) => {
        const formData = new FormData();
        formData.append('file', file);

        return fetch('/parse-w3g', {
            method: 'POST',
            body: formData
        })
            .then(response => response.json())
            .then(data => {
                fetchUpload(index, file.name, data, username, mapname, message);
            })
            .catch(error => {
                row.body.innerText = 'Error: ' + error.message;
            });
    });

    // Wait for all upload promises to resolve
    await Promise.allSettled(uploadPromises);
    document.documentElement.style.cursor = 'default';
});

function createRow(index, filename) {
    const resultsDiv = document.getElementById('results');

    // div
    const resultDiv = document.createElement('div');
    resultDiv.className = 'result-div';
    resultDiv.id = `result-${filename}`;
    resultDiv.dataset.index = index;
    resultDiv.style.order = index;

    // title
    const title = document.createElement('h3');
    title.innerText = filename;

    // body
    const body = document.createElement('p');
    body.innerText = 'Loading...';

    // hover panel
    const hoverPanel = document.createElement('div');
    hoverPanel.className = 'hover-panel';
    hoverPanel.innerHTML = "Loading...";

    // button to open chat history
    const chatButton = document.createElement('button');
    chatButton.disabled = true
    chatButton.id = `open-button-${filename}`
    chatButton.className = "open-button"
    chatButton.innerText = 'Chat History';
    chatButton.addEventListener('click', () => {
        // Hide all chat-popups
        const chatPopups = document.querySelectorAll('[id^="chat-popup-"]');
        chatPopups.forEach(popup => {
            popup.style.display = 'none';
        });

        document.getElementById(`chat-popup-${filename}`).style.display = 'block';
    });

    // button to open purchases
    const purchasesButton = document.createElement('button');
    purchasesButton.disabled = true;
    purchasesButton.id = `purchases-button-${filename}`;
    purchasesButton.className = "open-button";
    purchasesButton.innerText = 'Purchases';
    purchasesButton.addEventListener('click', () => {
        const allPopups = document.querySelectorAll('[id^="purchases-popup-"]');
        allPopups.forEach(popup => { popup.style.display = 'none'; });
        document.getElementById(`purchases-popup-${filename}`).style.display = 'block';
    });

    // button to open raw actions debug
    const rawActionsButton = document.createElement('button');
    rawActionsButton.disabled = true;
    rawActionsButton.id = `raw-actions-button-${filename}`;
    rawActionsButton.className = "open-button";
    rawActionsButton.innerText = 'Raw Actions';
    rawActionsButton.addEventListener('click', () => {
        const allPopups = document.querySelectorAll('[id^="raw-actions-popup-"]');
        allPopups.forEach(popup => { popup.style.display = 'none'; });
        document.getElementById(`raw-actions-popup-${filename}`).style.display = 'block';
    });

    resultDiv.appendChild(rawActionsButton);
    resultDiv.appendChild(purchasesButton);
    resultDiv.appendChild(chatButton);
    resultDiv.appendChild(title);
    resultDiv.appendChild(body);
    resultDiv.appendChild(hoverPanel);

    // hover panel events
    resultDiv.addEventListener('mouseenter', () => {
        hoverPanel.style.display = 'block';
    });

    resultDiv.addEventListener('mouseleave', () => {
        hoverPanel.style.display = 'none';
    });

    resultDiv.addEventListener('mousemove', (e) => {
        const panelWidth = hoverPanel.offsetWidth;
        const panelHeight = hoverPanel.offsetHeight;
        const pageWidth = window.innerWidth;
        const pageHeight = window.innerHeight;

        let leftPosition = e.pageX + 15;
        let topPosition = e.pageY + 15;

        // Check if the hover panel would extend beyond the right edge
        if (leftPosition + panelWidth > pageWidth) {
            leftPosition = e.pageX - panelWidth - 15;
        }

        // Check if the hover panel would extend beyond the bottom edge
        if (topPosition + panelHeight > pageHeight) {
            topPosition = e.pageY - panelHeight - 15;
        }

        hoverPanel.style.left = leftPosition + 'px';
        hoverPanel.style.top = topPosition + 'px';
    });

    resultsDiv.append(resultDiv)
    return { body, hoverPanel }
}

function createChatHistoryPopup(filename) {
    const chatPopups = document.getElementById('chat-container')

    // Create the chat popup
    const chatPopupDiv = document.createElement('div');
    chatPopupDiv.className = 'chat-popup';
    chatPopupDiv.id = `chat-popup-${filename}`;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'header';

    const closeChatButton = document.createElement('button');
    closeChatButton.className = 'close-button';
    closeChatButton.innerText = 'Close';
    closeChatButton.addEventListener('click', () => {
        document.getElementById(`chat-popup-${filename}`).style.display = 'none';
    });

    const chatTitle = document.createElement('h4');
    chatTitle.innerText = 'Chat History';

    headerDiv.appendChild(chatTitle);
    headerDiv.appendChild(closeChatButton);

    const chatContentDiv = document.createElement('div');
    chatContentDiv.className = 'chat-content';

    const chatHistory = document.createElement('ul');
    chatHistory.id = `chat-history-${filename}`;

    chatContentDiv.appendChild(chatHistory);

    chatPopupDiv.appendChild(headerDiv);
    chatPopupDiv.appendChild(chatContentDiv);

    chatPopups.append(chatPopupDiv)
    return chatPopupDiv
}

function fetchUpload(index, filename, data, username, mapname, message) {
    const gameData = data.gameData;
    const playerData = data.playerData;
    const chat = data.chatData;
    const loots = data.loots;
    const purchases = data.purchases || [];
    const rawActionLog = data.rawActionLog || [];
    const w3gRaw = data.w3gRaw || {};

    // filters
    if (username !== "") {
        const playerName = playerData.some(player => player.playerName.toLowerCase().includes(username.toLowerCase()))
        const convertedName = playerData.some(player => player.convertedName.toLowerCase().includes(username.toLowerCase()))
        if (!playerName && !convertedName) {
            return
        }
    }

    if (mapname !== "") {
        if (!gameData.map.toLowerCase().includes(mapname.toLowerCase())) {
            return
        }
    }

    if (message !== "") {
        if (!chat.some(chat => chat.message.toLowerCase().includes(message.toLowerCase()))) {
            return
        }
    }
    
    // elements
    const gameDataHtml = `
    <strong>Game Information:</strong><br>
    Version: ${gameData.version || 0}<br>
    Length: ${gameData.length}<br>
    Map: ${gameData.map}<br>
    Host: ${gameData.host}<br>
    Game Name: ${gameData.gameName}<br>
    <br>
    <strong>Players:</strong><br>
    ${playerData.map(player => {
        // Show the hero's class (heroClass) for the loaded hero, falling back to
        // the hero name only when the class isn't known.
        const heroLabel = player.hero
            ? (player.hero.heroClass || player.hero.name)
            : 'No hero';
        return `<span style="color:#${player.hex};">● ${player.playerName}</span> - ${heroLabel}`;
    }).join('<br>')}`
    // Craft events (experimental, behind the "Show craft events" toggle).
    + (() => {
        const craftEvents = data.craftEvents || [];
        const lines = craftEvents.length
            ? craftEvents.map(c => `${c.gameTime} - <span style="font-weight:bold;">${c.playerName}</span> opened the craft menu (${c.craftCode})`).join('<br>')
            : 'No craft menu events detected.';
        return `<div class="craft-events"><br><strong>🔨 Craft menu events (experimental):</strong><br>`
            + `<em style="opacity:.7;">Note: the replay records that a craft menu was opened, not the item produced.</em><br>`
            + `${lines}</div>`;
    })();

    const row = createRow(index, filename);
    createChatHistoryPopup(filename);
    createPurchasesPopup(filename);
    createRawActionsPopup(filename);

    row.hoverPanel.innerHTML = gameDataHtml;

    let bodyLines = [];

    bodyLines.push('=== Loots ===');
    if (loots.length === 0) {
        bodyLines.push('No loot items found.');
    } else {
        bodyLines.push(...loots.map(loot => `${loot.gameTime} ${loot.playerName}: ${loot.itemName}`));
    }

    // w3gjs generated player items/heroes
    if (playerData.some(p => p.w3gItems?.length > 0 || p.w3gHeroes?.length > 0)) {
        bodyLines.push('');
        bodyLines.push('=== w3gjs player details ===');
        playerData.forEach(player => {
            const playerHeader = `${player.playerName} (ID ${player.playerId})`;
            bodyLines.push(`- ${playerHeader}`);

            const w3gItems = player.w3gItems || [];
            if (w3gItems.length > 0) {
                bodyLines.push('   items:');
                w3gItems.forEach(i => bodyLines.push(`     • ${i.itemName || i.itemId} (${i.itemId}) x${i.count}`));
            }

            const w3gHeroes = player.w3gHeroes || [];
            if (w3gHeroes.length > 0) {
                bodyLines.push('   heroes:');
                w3gHeroes.forEach(h => bodyLines.push(`     • ${h.name || h.code} (${h.code})`));
            }
        });
    }

    row.body.innerText = bodyLines.join('\n');

    fetchChatHistory(filename, chat); // Function to fetch and display chat history
    fetchPurchases(filename, purchases);
    fetchRawActions(filename, rawActionLog, playerData);
}

function fetchChatHistory(fileName, chatData) {
    const chatHistory = document.getElementById(`chat-history-${fileName}`);
    chatHistory.innerHTML = ''; // Clear previous chat history

    chatData.forEach(chat => {
        const chatLine = document.createElement('li');
        chatLine.innerHTML = `<span style="color: inherit;">[${chat.mode}] ${chat.time} <span style="color:#${chat.color};">${chat.player}</span>: ${chat.message}</span>`;
        chatHistory.appendChild(chatLine);
    });

    const chatButton = document.getElementById(`open-button-${fileName}`)
    chatButton.disabled = false
}

// Function to get unique data based on id and newest timestamp
function filterUniqueNewest(dataArray) {
    const uniqueData = dataArray.reduce((acc, current) => {
        const existing = acc.find(item => item.id === current.id);
        if (!existing || new Date(current.timestamp) > new Date(existing.timestamp)) {
            // If no existing object or current object is newer, replace/add it
            acc = acc.filter(item => item.id !== current.id); // Remove existing
            acc.push(current); // Add current
        }
        return acc;
    }, []);

    return uniqueData;
}

function closeChatPopup() {
    document.getElementById('chatPopup').style.display = 'none';
}

function createPurchasesPopup(filename) {
    const container = document.getElementById('purchases-container');

    const popup = document.createElement('div');
    popup.className = 'purchases-popup';
    popup.id = `purchases-popup-${filename}`;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'header';

    const title = document.createElement('h4');
    title.innerText = 'Purchases / Craft Events';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-button';
    closeBtn.innerText = 'Close';
    closeBtn.addEventListener('click', () => {
        popup.style.display = 'none';
    });

    headerDiv.appendChild(title);
    headerDiv.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'purchases-content';

    const list = document.createElement('ul');
    list.id = `purchases-list-${filename}`;

    content.appendChild(list);
    popup.appendChild(headerDiv);
    popup.appendChild(content);
    container.appendChild(popup);
}

function createRawActionsPopup(filename) {
    const container = document.getElementById('raw-actions-container');

    const popup = document.createElement('div');
    popup.className = 'purchases-popup';
    popup.id = `raw-actions-popup-${filename}`;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'header';

    const title = document.createElement('h4');
    title.innerText = 'Raw Actions Debug (IDs 0x10–0x14)';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-button';
    closeBtn.innerText = 'Close';
    closeBtn.addEventListener('click', () => { popup.style.display = 'none'; });

    headerDiv.appendChild(title);
    headerDiv.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'purchases-content';
    content.id = `raw-actions-content-${filename}`;

    popup.appendChild(headerDiv);
    popup.appendChild(content);
    container.appendChild(popup);
}

function fetchRawActions(filename, rawActionLog, playerData) {
    const content = document.getElementById(`raw-actions-content-${filename}`);
    if (!content) return;
    content.innerHTML = '';

    const btn = document.getElementById(`raw-actions-button-${filename}`);
    if (btn) btn.disabled = false;

    if (rawActionLog.length === 0) {
        content.innerHTML = '<p>No ability actions (0x10–0x14) detected.</p>';
        return;
    }

    // Summary: count by actionId+abilityFlags combo
    const comboCounts = {};
    rawActionLog.forEach(entry => {
        const key = `${entry.actionIdHex} flags=${entry.abilityFlagsHex}`;
        comboCounts[key] = (comboCounts[key] || 0) + 1;
    });

    const summaryTitle = document.createElement('h5');
    summaryTitle.innerText = 'Combo Summary (actionId + abilityFlags)';
    content.appendChild(summaryTitle);

    const summaryList = document.createElement('ul');
    Object.entries(comboCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([key, count]) => {
            const li = document.createElement('li');
            li.innerText = `${key} — ${count} events`;
            summaryList.appendChild(li);
        });
    content.appendChild(summaryList);

    // Full log table
    const logTitle = document.createElement('h5');
    logTitle.innerText = 'Full Action Log';
    content.appendChild(logTitle);

    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;font-size:11px;width:100%;';
    table.innerHTML = `<thead><tr>
        <th style="border:1px solid #555;padding:2px 4px;">Time</th>
        <th style="border:1px solid #555;padding:2px 4px;">Player</th>
        <th style="border:1px solid #555;padding:2px 4px;">actionId</th>
        <th style="border:1px solid #555;padding:2px 4px;">flags</th>
        <th style="border:1px solid #555;padding:2px 4px;">itemId</th>
        <th style="border:1px solid #555;padding:2px 4px;">itemId1</th>
        <th style="border:1px solid #555;padding:2px 4px;">itemId2</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');

    rawActionLog.forEach(entry => {
        const player = playerData.find(p => p.playerId === entry.playerId);
        const playerName = player ? (player.convertedName || player.playerName) : `P${entry.playerId}`;
        const color = player ? player.hex : 'e0e0e0';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="border:1px solid #444;padding:2px 4px;">${entry.timeReadable}</td>
            <td style="border:1px solid #444;padding:2px 4px;"><span style="color:#${color}">${playerName}</span></td>
            <td style="border:1px solid #444;padding:2px 4px;">${entry.actionIdHex}</td>
            <td style="border:1px solid #444;padding:2px 4px;">${entry.abilityFlagsHex ?? '-'}</td>
            <td style="border:1px solid #444;padding:2px 4px;">${entry.itemId ?? '-'}</td>
            <td style="border:1px solid #444;padding:2px 4px;">${entry.itemId1 ?? '-'}</td>
            <td style="border:1px solid #444;padding:2px 4px;">${entry.itemId2 ?? '-'}</td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    content.appendChild(table);
}

function fetchPurchases(filename, purchasesData) {
    const list = document.getElementById(`purchases-list-${filename}`);
    if (!list) return;
    list.innerHTML = '';

    if (purchasesData.length === 0) {
        const li = document.createElement('li');
        li.innerText = 'No purchase or craft events detected.';
        list.appendChild(li);
    } else {
        purchasesData.forEach(p => {
            const li = document.createElement('li');
            const color = p.playerColor || 'e0e0e0';
            li.innerHTML = `[${p.gameTime}] <span style="color:#${color}">${p.playerName}</span>: ${p.itemName}`;
            list.appendChild(li);
        });
    }

    const btn = document.getElementById(`purchases-button-${filename}`);
    if (btn) btn.disabled = false;
}
// ---------------------------------------------------------------------------
// Feature flag: "Show craft events" toggle.
// Craft menu events are hidden by default; this fixed checkbox enables/disables
// them globally (persisted in localStorage). CSS hides .craft-events unless the
// body has the .show-crafts class.
// ---------------------------------------------------------------------------
function setupCraftToggle() {
    if (document.getElementById('craft-toggle')) return;

    const style = document.createElement('style');
    style.textContent =
        '.craft-events{display:none;}' +
        'body.show-crafts .craft-events{display:block;margin-top:4px;}';
    document.head.appendChild(style);

    const label = document.createElement('label');
    label.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:99999;background:#2b2b2b;color:#fff;' +
        'padding:6px 10px;border-radius:6px;font:12px/1.2 sans-serif;cursor:pointer;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.4);user-select:none;';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'craft-toggle';
    cb.style.cssText = 'vertical-align:middle;margin-right:6px;';
    cb.checked = localStorage.getItem('showCrafts') === '1';
    document.body.classList.toggle('show-crafts', cb.checked);

    cb.addEventListener('change', () => {
        document.body.classList.toggle('show-crafts', cb.checked);
        localStorage.setItem('showCrafts', cb.checked ? '1' : '0');
    });

    label.appendChild(cb);
    label.appendChild(document.createTextNode('🔨 Show craft events (beta)'));
    document.body.appendChild(label);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupCraftToggle);
} else {
    setupCraftToggle();
}
