// app.js (with persistent progress + fixed leaderboard + toasts)
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js";

/* ===========================
   REQUIRED SETTINGS (FILLED)
=========================== */
// Chain ID: 1270 (dec) = 0x4F6 (hex)
const IRYS_CHAIN_ID_HEX = "0x4F6";
const IRYS_PARAMS = {
  chainId: IRYS_CHAIN_ID_HEX,
  chainName: "Irys Testnet",
  nativeCurrency: { name: "Irys Test", symbol: "tIRYS", decimals: 18 },
  rpcUrls: ["https://testnet-rpc.irys.xyz/v1/execution-rpc"],
  blockExplorerUrls: ["https://explorer.irys.xyz/"]
};
const CONTRACT_ADDRESS = "0x077d85eeEebaA96515CEAd8C3d3947835369B761";
const DEPLOY_BLOCK = 9117711;     // your deploy block
const LB_LOOKBACK_BLOCKS = 20000; // fallback window if not using DEPLOY_BLOCK

/* ===========================
             ABI
=========================== */
const ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "player", type: "address" },
      { indexed: true, internalType: "bytes32", name: "dayId", type: "bytes32" },
      { indexed: false, internalType: "string", name: "uri", type: "string" },
      { indexed: false, internalType: "bool", name: "solved", type: "bool" },
      { indexed: false, internalType: "uint8", name: "tryIndex", type: "uint8" }
    ],
    name: "Attempt",
    type: "event"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "dayId", type: "bytes32" },
      { internalType: "string", name: "uri", type: "string" },
      { internalType: "bool", name: "solved", type: "bool" },
      { internalType: "uint8", name: "tryIndex", type: "uint8" }
    ],
    name: "submitAttempt",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "dayId", type: "bytes32" },
      { internalType: "address", name: "player", type: "address" }
    ],
    name: "bestTryFor",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function"
  }
];

/* ===========================
         Game Config
=========================== */
const STAGES_PER_DAY = 4;
const WORDLIST = ["irysx", "alpha", "chain", "store", "proof", "miner", "agent", "swarm", "datax", "evmxx"];

/* ===========================
          DOM Elements
=========================== */
// Nav / chips
const connectBtn = document.getElementById("connectBtn");
const connectedGroup = document.getElementById("connectedGroup");
const balanceChip = document.getElementById("balanceChip");
const balanceText = document.getElementById("balanceText");
const addrChip = document.getElementById("addrChip");
const addrShortEl = document.getElementById("addrShort");

// Game
const addrEl = document.getElementById("addr");
const todayEl = document.getElementById("todayStr");
const guessEl = document.getElementById("guess");
const submitBtn = document.getElementById("submitBtn");
const board = document.getElementById("board");
const mintStatus = document.getElementById("mintStatus");
const txLink = document.getElementById("txLink");

const stageNowEl = document.getElementById("stageNow");
const stageTotalEl = document.getElementById("stageTotal");

// Leaderboard
const lbDate = document.getElementById("lbDate");
const lbStageEl = document.getElementById("lbStage");
const loadLbBtn = document.getElementById("loadLbBtn");
const lbStatus = document.getElementById("lbStatus");
const lbTableBody = document.querySelector("#lbTable tbody");

// Modals / toasts
const walletModal = document.getElementById("walletModal");
const walletModalClose = document.getElementById("walletModalClose");
const toastHost = document.getElementById("toastHost");

/* ===========================
          State / Init
=========================== */
const todayStr = new Date().toISOString().slice(0, 10);
if (todayEl) todayEl.textContent = todayStr;

let provider, signer, contract, account;
let currentStage = 1;
let tryIndex = 1;

// persistent rows: [{stage, guess, pattern}]
let gameRows = [];

if (stageTotalEl) stageTotalEl.textContent = STAGES_PER_DAY;
if (stageNowEl) stageNowEl.textContent = currentStage;
if (lbDate) lbDate.value = todayStr;
if (lbStageEl) lbStageEl.value = "1";

/* ===========================
          Persistence
=========================== */
const STORAGE_KEY_PREFIX = "irys-word-hunt";
const stateKey = (dateStr) => `${STORAGE_KEY_PREFIX}:${dateStr}`;

function saveState() {
  try {
    const data = {
      currentStage,
      tryIndex,
      rows: gameRows,
      completed: !!(guessEl?.disabled)
    };
    localStorage.setItem(stateKey(todayStr), JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

function rebuildBoard() {
  if (!board) return;
  board.innerHTML = "";
  let prevStage = null;
  for (const r of gameRows) {
    if (prevStage !== null && r.stage !== prevStage) {
      const hr = document.createElement("hr");
      board.appendChild(hr);
    }
    renderRow(r.guess, r.pattern);
    prevStage = r.stage;
  }
}

function hydrateFromStorage() {
  try {
    const raw = localStorage.getItem(stateKey(todayStr));
    if (!raw) return;
    const s = JSON.parse(raw);
    if (typeof s.currentStage === "number") currentStage = Math.min(Math.max(1, s.currentStage), STAGES_PER_DAY);
    if (typeof s.tryIndex === "number") tryIndex = Math.max(1, s.tryIndex);
    if (Array.isArray(s.rows)) gameRows = s.rows.filter(r => r && typeof r.stage === "number" && typeof r.guess === "string" && typeof r.pattern === "string");
    rebuildBoard();
    if (stageNowEl) stageNowEl.textContent = currentStage;
    if (s.completed) {
      if (guessEl) guessEl.disabled = true;
      if (submitBtn) submitBtn.disabled = true;
    }
  } catch (e) {
    console.error("hydrate failed:", e);
  }
}
// hydrate immediately
hydrateFromStorage();

/* ===========================
          UI Helpers
=========================== */
function short(addr) { return addr ? (addr.slice(0, 6) + "…" + addr.slice(-4)) : ""; }
function showWalletModal(show) { if (!walletModal) return; walletModal.style.display = show ? "grid" : "none"; }
walletModalClose && (walletModalClose.onclick = () => showWalletModal(false));

function toast(msg, kind = "info", ms = 2800) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const h = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  }, ms);
  return { close: () => { clearTimeout(h); t.classList.remove("show"); setTimeout(() => t.remove(), 250); } };
}

function renderRow(guess, pattern) {
  const wrap = document.createElement('div');
  for (let i = 0; i < guess.length; i++) {
    const tile = document.createElement('span');
    tile.className = `tile ${pattern[i]}`;
    tile.textContent = guess[i].toUpperCase();
    wrap.appendChild(tile);
  }
  board && board.appendChild(wrap);
}

/* ===========================
        Word + IDs
=========================== */
function compare(guess, target) {
  guess = guess.toLowerCase();
  const res = Array(guess.length).fill('n'), tcount = {};
  for (let c of target) { tcount[c] = (tcount[c] || 0) + 1; }
  for (let i = 0; i < guess.length; i++) { if (guess[i] === target[i]) { res[i] = 'g'; tcount[guess[i]]--; } }
  for (let i = 0; i < guess.length; i++) { if (res[i] === 'n' && tcount[guess[i]] > 0) { res[i] = 'y'; tcount[guess[i]]--; } }
  return res.join('');
}
function dailyWord(dayStr, stage) {
  const seed = `${dayStr}#${stage}`;
  const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(seed));
  const n = parseInt(hash.slice(2, 10), 16);
  return WORDLIST[n % WORDLIST.length];
}
function currentSolution() { return dailyWord(todayStr, currentStage); }
function dayStageId(dayStr, stage) {
  const key = `${dayStr}#${stage}`;
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(key));
}

/* ===========================
     Wallet / Network
=========================== */
async function ensureIrysChain(eip) {
  const prov = new ethers.providers.Web3Provider(eip);
  const net = await prov.getNetwork();
  if (net.chainId !== parseInt(IRYS_CHAIN_ID_HEX, 16)) {
    await eip.request({ method: "wallet_addEthereumChain", params: [IRYS_PARAMS] });
    toast("Irys testnet switched", "success");
  }
}

async function connect() {
  const okx = window.okxwallet ? window.okxwallet : null;
  const eip = okx || window.ethereum;
  if (!eip) { toast("Install OKX Wallet (or another EVM wallet).", "error", 3800); return; }

  showWalletModal(true);
  try {
    await eip.request({ method: "eth_requestAccounts" });
    await ensureIrysChain(eip);
    provider = new ethers.providers.Web3Provider(eip);
    signer = provider.getSigner();
    account = await signer.getAddress();

    if (!ethers.utils.isAddress(CONTRACT_ADDRESS)) {
      toast("Invalid CONTRACT_ADDRESS. Paste the full 0x… from Remix.", "error", 5200);
      showWalletModal(false);
      return;
    }
    await provider.getNetwork();
    let code = "0x";
    try { code = await provider.getCode(CONTRACT_ADDRESS); }
    catch (e) { console.error("getCode failed:", e); toast("Could not read contract code.", "error", 5200); }
    if (!code || code === "0x") {
      toast("No contract at this address on this network.", "error", 5200);
    }

    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    if (addrEl) addrEl.textContent = account;
    if (addrShortEl) addrShortEl.textContent = short(account);
    connectBtn && connectBtn.classList.add("hidden");
    connectedGroup && connectedGroup.classList.remove("hidden");

    await refreshBalance();
    toast("Wallet connected", "success");
  } catch (e) {
    console.error(e);
    toast(e?.message || "Connection rejected", "error", 4200);
  } finally {
    showWalletModal(false);
  }
}

async function refreshBalance() {
  if (!provider || !account) return;
  const wei = await provider.getBalance(account);
  const sym = IRYS_PARAMS.nativeCurrency?.symbol || "IRYS";
  const val = Number(ethers.utils.formatEther(wei)).toFixed(3);
  if (balanceText) balanceText.textContent = `${val} ${sym}`;
}

/* ===========================
  Placeholder Irys upload
=========================== */
async function uploadAttemptToIrys(payload) {
  // TODO: integrate Irys SDK and return a real content URI
  return `irys://attempt-${Date.now()}`;
}

/* ===========================
        Submit Guess
=========================== */
async function submitGuess() {
  if (!signer) { await connect(); if (!signer) return; }

  const net = await signer.provider.getNetwork();
  if (net.chainId !== parseInt(IRYS_CHAIN_ID_HEX, 16)) {
    toast("Please switch to Irys Testnet", "error"); return;
  }

  const bal = await provider.getBalance(account);
  if (bal.eq(0)) toast("You need some test IRYS for gas.", "error", 4000);

  if (currentStage > STAGES_PER_DAY) {
    toast("Daily challenge already completed 🎉", "info"); return;
  }

  const guess = (guessEl.value || "").trim().toLowerCase();
  if (!/^[a-z]{5}$/.test(guess)) { toast("Enter exactly 5 letters (A–Z).", "error"); return; }

  const solution = currentSolution();
  const pattern = compare(guess, solution);
  renderRow(guess, pattern);

  // Persist row immediately (even if tx fails), then save
  gameRows.push({ stage: currentStage, guess, pattern });
  saveState();

  const solved = (pattern === 'ggggg');
  if (mintStatus) mintStatus.textContent = "Uploading attempt (placeholder)…";
  const uri = await uploadAttemptToIrys({
    game: "irys-word-hunt", date: todayStr, stage: currentStage, wallet: account,
    guess, result: pattern.replaceAll('n', '-').toUpperCase(), tryIndex, solved
  });

  const id = dayStageId(todayStr, currentStage);

  const pending = toast("Sending Transaction", "info", 60000);
  try {
    const tx = await contract.submitAttempt(id, uri, solved, tryIndex);
    await tx.wait();
    pending.close();
    toast("Transaction confirmed ✅", "success");
    if (txLink) txLink.innerHTML = `<a href="${IRYS_PARAMS.blockExplorerUrls[0]}/tx/${tx.hash}" target="_blank">View Tx</a>`;
    if (mintStatus) mintStatus.innerHTML = `<span class="ok">Recorded attempt #${tryIndex}${solved ? " (SOLVED)" : "."}</span>`;
  } catch (e) {
    pending.close();
    console.error(e);
    toast(e?.reason || e?.message || "Transaction failed", "error", 5000);
    // still keep the row in local progress
    tryIndex++;
    guessEl.value = "";
    saveState();
    return;
  }

  tryIndex++;
  guessEl.value = "";
  saveState();

  if (solved) {
    // Auto-refresh leaderboard for the stage we just completed
    try { await loadLeaderboardFor(todayStr, currentStage); } catch (_) { }

    currentStage++;
    if (currentStage <= STAGES_PER_DAY) {
      if (stageNowEl) stageNowEl.textContent = currentStage;
      tryIndex = 1;
      const hr = document.createElement('hr'); board && board.appendChild(hr);
    } else {
      if (stageNowEl) stageNowEl.textContent = STAGES_PER_DAY;
      toast("Daily challenge completed! 🎉", "success");
      if (guessEl) guessEl.disabled = true;
      if (submitBtn) submitBtn.disabled = true;
    }
    saveState(); // persist stage advance / completion
  }
}

/* ===========================
        Leaderboard
=========================== */
function renderLeaderboard(rows) {
  if (!lbTableBody) return;
  lbTableBody.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${short(r.player)}</td><td>${r.bestTry}</td><td>${new Date(r.firstSolvedAt * 1000).toLocaleString()}</td>`;
    lbTableBody.appendChild(tr);
  });
}

async function loadLeaderboardFor(dayStr, stage) {
  if (!provider) {
    const okx = window.okxwallet ? window.okxwallet : null;
    const eip = okx || window.ethereum;
    if (!eip) { toast("No wallet provider", "error"); return; }
    provider = new ethers.providers.Web3Provider(eip);
  }
  if (!contract && signer) {
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
  }

  if (lbStatus) lbStatus.textContent = "Loading attempts…";

  const s = Math.max(1, Math.min(STAGES_PER_DAY, parseInt(stage || "1", 10)));
  const dayIdHex = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${dayStr}#${s}`));

  const iface = new ethers.utils.Interface(ABI);
  const eventTopic = iface.getEventTopic("Attempt");

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = (DEPLOY_BLOCK && DEPLOY_BLOCK > 0)
    ? DEPLOY_BLOCK
    : Math.max(0, currentBlock - LB_LOOKBACK_BLOCKS);

  const filter = {
    address: CONTRACT_ADDRESS,
    fromBlock,
    toBlock: "latest",
    topics: [eventTopic, null, dayIdHex]
  };

  let logs = [];
  try { logs = await provider.getLogs(filter); }
  catch (e) { console.error("getLogs error:", e); toast("Failed to read logs from RPC.", "error", 4500); return; }

  const best = new Map(); // addr -> { bestTry, firstSolvedAt }
  for (const lg of logs) {
    let parsed; try { parsed = iface.parseLog(lg); } catch { continue; }
    const { player, solved, tryIndex } = parsed.args;
    if (!solved) continue;

    const addr = player.toLowerCase();
    const block = await provider.getBlock(lg.blockNumber);
    const ts = block.timestamp;

    if (!best.has(addr)) best.set(addr, { bestTry: Number(tryIndex), firstSolvedAt: ts });
    else {
      const rec = best.get(addr);
      if (Number(tryIndex) < rec.bestTry) rec.bestTry = Number(tryIndex);
      else if (Number(tryIndex) === rec.bestTry && ts < rec.firstSolvedAt) rec.firstSolvedAt = ts;
    }
  }

  const rows = Array.from(best.entries())
    .map(([player, v]) => ({ player, ...v }))
    .sort((a, b) => (a.bestTry - b.bestTry) || (a.firstSolvedAt - b.firstSolvedAt));

  if (!rows.length) { if (lbStatus) lbStatus.textContent = "No solved attempts yet for this stage."; renderLeaderboard([]); return; }
  if (lbStatus) lbStatus.textContent = `Found ${rows.length} solver(s).`;
  renderLeaderboard(rows);
}

/* ===========================
           Wire Up
=========================== */
connectBtn && (connectBtn.onclick = connect);
addrChip && (addrChip.onclick = () => navigator.clipboard?.writeText(account || ""));
balanceChip && (balanceChip.onclick = refreshBalance);

submitBtn && (submitBtn.onclick = submitGuess);
guessEl && guessEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submitGuess(); });

loadLbBtn && (loadLbBtn.onclick = async () => {
  try { await loadLeaderboardFor(lbDate ? lbDate.value : todayStr, lbStageEl ? lbStageEl.value : "1"); }
  catch (e) { console.error(e); toast(e?.message || "Failed to load leaderboard", "error", 4200); }
});
