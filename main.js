  import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js";

  // ====== FILL THESE VALUES ======
  const IRYS_CHAIN_ID_HEX = "0x4F6"; // e.g., 1270 decimal = 0x4F6
  const IRYS_PARAMS = {
    chainId: IRYS_CHAIN_ID_HEX,
    chainName: "Irys Testnet",
    nativeCurrency: { name: "Irys Testnet", symbol: "IRYS", decimals: 18 }, // <-- set symbol if different
    rpcUrls: ["https://testnet-rpc.irys.xyz/v1/execution-rpc"],       // e.g., "https://testnet.irys.io/rpc"
    blockExplorerUrls: ["https://explorer.irys.xyz/"] // e.g., "https://explorer.testnet.irys.io"
  };
  const CONTRACT_ADDRESS = "0x077d85eeEebaA96515CEAd8C3d3947835369B761";

  // Set this to the block number where you deployed the contract (for faster log queries)
  const DEPLOY_BLOCK = 9117711; // e.g., 123456

  // ====== ABI (minimal) ======
  const ABI = [
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true,  "internalType": "address", "name": "player",  "type": "address" },
        { "indexed": true,  "internalType": "bytes32", "name": "dayId",   "type": "bytes32" },
        { "indexed": false, "internalType": "string",  "name": "uri",     "type": "string" },
        { "indexed": false, "internalType": "bool",    "name": "solved",  "type": "bool" },
        { "indexed": false, "internalType": "uint8",   "name": "tryIndex","type": "uint8" }
      ],
      "name": "Attempt",
      "type": "event"
    },
    {
      "inputs": [
        { "internalType": "bytes32", "name": "dayId",    "type": "bytes32" },
        { "internalType": "string",  "name": "uri",      "type": "string" },
        { "internalType": "bool",    "name": "solved",   "type": "bool" },
        { "internalType": "uint8",   "name": "tryIndex", "type": "uint8" }
      ],
      "name": "submitAttempt",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "bytes32", "name": "dayId",  "type": "bytes32" },
        { "internalType": "address", "name": "player","type": "address" }
      ],
      "name": "bestTryFor",
      "outputs": [{ "internalType": "uint8", "name": "", "type": "uint8" }],
      "stateMutability": "view",
      "type": "function"
    }
  ];

  // ====== Game Config ======
  const STAGES_PER_DAY = 4;
  const WORDLIST = ["irysx","alpha","chain","store","proof","miner","agent","swarm","datax","evmxx"]; // extend anytime

  // ====== UI Elements (make sure these IDs exist in your HTML) ======
  const connectBtn  = document.getElementById("connectBtn");
  const addChainBtn = document.getElementById("addChainBtn");
  const statusEl    = document.getElementById("status");
  const addrEl      = document.getElementById("addr");
  const todayEl     = document.getElementById("todayStr");
  const guessEl     = document.getElementById("guess");
  const submitBtn   = document.getElementById("submitBtn");
  const board       = document.getElementById("board");
  const mintStatus  = document.getElementById("mintStatus");
  const txLink      = document.getElementById("txLink");

  // NEW: stage indicators
  const stageNowEl   = document.getElementById("stageNow");   // <span id="stageNow"></span>
  const stageTotalEl = document.getElementById("stageTotal"); // <span id="stageTotal"></span>

  // Leaderboard bits
  const lbDate       = document.getElementById("lbDate");     // <input type="date" id="lbDate" />
  const lbStageEl    = document.getElementById("lbStage");    // <input type="number" id="lbStage" min="1" max="4" value="1" />
  const loadLbBtn    = document.getElementById("loadLbBtn");  // <button id="loadLbBtn">...</button>
  const lbStatus     = document.getElementById("lbStatus");   // <div id="lbStatus"></div>
  const lbTableBody  = document.querySelector("#lbTable tbody"); // <table id="lbTable"><tbody></tbody></table>

  // ====== State ======
  const todayStr = new Date().toISOString().slice(0,10); // YYYY-MM-DD
  todayEl && (todayEl.textContent = todayStr);

  let provider, signer, contract, account;
  let currentStage = 1; // 1..STAGES_PER_DAY
  let tryIndex = 1;

  // Initialize small UI bits
  if (stageTotalEl) stageTotalEl.textContent = STAGES_PER_DAY;
  if (stageNowEl)   stageNowEl.textContent   = currentStage;
  if (lbDate)       lbDate.value             = todayStr;
  if (lbStageEl)    lbStageEl.value          = "1";

  // ====== Helpers ======
  function logOk(msg){ if (statusEl) statusEl.innerHTML = `<span class="ok">${msg}</span>`; }
  function logErr(msg){ if (statusEl) statusEl.innerHTML = `<span class="err">${msg}</span>`; }
  function short(addr){ return addr.slice(0,6) + "…" + addr.slice(-4); }

  // Word compare ('g' green, 'y' yellow, 'n' gray)
  function compare(guess, target){
    guess = guess.toLowerCase();
    const res = Array(guess.length).fill('n');
    const tcount = {};
    for (let c of target){ tcount[c] = (tcount[c]||0)+1; }
    for (let i=0;i<guess.length;i++){
      if (guess[i]===target[i]){ res[i]='g'; tcount[guess[i]]--; }
    }
    for (let i=0;i<guess.length;i++){
      if (res[i]==='n' && tcount[guess[i]]>0){ res[i]='y'; tcount[guess[i]]--; }
    }
    return res.join('');
  }

  function renderRow(guess, pattern){
    const wrap = document.createElement('div');
    for (let i=0;i<guess.length;i++){
      const tile = document.createElement('span');
      tile.className = `tile ${pattern[i]}`;
      tile.textContent = guess[i].toUpperCase();
      wrap.appendChild(tile);
    }
    board && board.appendChild(wrap);
  }

  // Stage-aware word + on-chain id
  function dailyWord(dayStr, stage){
    const seed = `${dayStr}#${stage}`;
    const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(seed));
    const n = parseInt(hash.slice(2,10), 16);
    return WORDLIST[n % WORDLIST.length];
  }
  function currentSolution(){ return dailyWord(todayStr, currentStage); }
  function dayStageId(dayStr, stage){
    const key = `${dayStr}#${stage}`;
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(key));
  }

  // ====== Wallet / Network ======
  async function connect(){
    if (!window.ethereum){ alert("Install MetaMask"); return; }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();
    account = await signer.getAddress();
    if (addrEl) addrEl.textContent = account;
    logOk("Wallet connected");
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
  }

  async function addOrSwitch(){
    try {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [IRYS_PARAMS] });
      logOk("Irys testnet added/switched.");
    } catch(e){ logErr(e.message); }
  }

  // ====== Placeholder: Replace with real Irys SDK upload ======
  async function uploadAttemptToIrys(payload){
    // TODO: Upload JSON to Irys and return a URI like irys://xxxx
    return `irys://attempt-${Date.now()}`;
  }

  // ====== Submit Guess (with stage progression) ======
  async function submitGuess(){
    if (!signer){ await connect(); }
    const net = await signer.provider.getNetwork();
    if (net.chainId !== parseInt(IRYS_CHAIN_ID_HEX,16)){ alert("Switch to Irys Testnet"); return; }

    if (currentStage > STAGES_PER_DAY){
      alert("You already completed all stages for today! 🎉");
      return;
    }

    const guess = (guessEl.value||"").trim().toLowerCase();
    if (guess.length !== 5){ alert("Enter exactly 5 letters"); return; }

    const solution = currentSolution();
    const pattern = compare(guess, solution);
    renderRow(guess, pattern);

    const solved = (pattern === 'ggggg');

    mintStatus && (mintStatus.textContent = "Uploading attempt (placeholder)…");
    const uri = await uploadAttemptToIrys({
      game: "irys-word-hunt",
      date: todayStr,
      stage: currentStage,
      wallet: account,
      guess,
      result: pattern.replaceAll('n','-').toUpperCase(),
      tryIndex,
      solved
    });

    const id = dayStageId(todayStr, currentStage);

    mintStatus && (mintStatus.textContent = "Sending onchain tx…");
    const tx = await contract.submitAttempt(id, uri, solved, tryIndex);
    await tx.wait();

    if (txLink) txLink.innerHTML = `<a href="${IRYS_PARAMS.blockExplorerUrls[0]}/tx/${tx.hash}" target="_blank">View Tx</a>`;
    mintStatus && (mintStatus.innerHTML = `<span class="ok">Recorded attempt #${tryIndex}${solved?" (SOLVED)":"."}</span>`);
    tryIndex++;
    guessEl.value = "";

    if (solved){
      currentStage++;
      if (currentStage <= STAGES_PER_DAY){
        stageNowEl && (stageNowEl.textContent = currentStage);
        tryIndex = 1;
        const hr = document.createElement('hr');
        board && board.appendChild(hr);
      } else {
        stageNowEl && (stageNowEl.textContent = STAGES_PER_DAY);
        mintStatus && (mintStatus.innerHTML += " 🎉 Daily challenge completed!");
        guessEl.disabled = true;
        submitBtn.disabled = true;
      }
    }
  }

  // ====== Leaderboard (per-stage) ======
  function renderLeaderboard(rows){
    if (!lbTableBody) return;
    lbTableBody.innerHTML = "";
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="padding:6px 0;">${i+1}</td>
        <td style="padding:6px 0;">${short(r.player)}</td>
        <td style="padding:6px 0;">${r.bestTry}</td>
        <td style="padding:6px 0;">${new Date(r.firstSolvedAt*1000).toLocaleString()}</td>
      `;
      lbTableBody.appendChild(tr);
    });
  }

  async function loadLeaderboardFor(dayStr, stage){
    if (!provider || !contract) { await connect(); }

    lbStatus && (lbStatus.textContent = "Loading attempts…");

    const s = Math.max(1, Math.min(STAGES_PER_DAY, parseInt(stage || "1", 10)));
    const dayId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${dayStr}#${s}`));
    const filter = contract.filters.Attempt(null, dayId);

    let events = await contract.queryFilter(filter, DEPLOY_BLOCK, "latest");

    const best = new Map(); // addr -> { bestTry, firstSolvedAt }
    for (const ev of events) {
      const { player, solved, tryIndex } = ev.args;
      if (!solved) continue;
      const addr = player.toLowerCase();

      const block = await provider.getBlock(ev.blockNumber);
      const ts = block.timestamp;

      if (!best.has(addr)) {
        best.set(addr, { bestTry: tryIndex, firstSolvedAt: ts });
      } else {
        const rec = best.get(addr);
        if (tryIndex < rec.bestTry) {
          rec.bestTry = tryIndex;
          // keep earlier timestamp
        } else if (tryIndex === rec.bestTry && ts < rec.firstSolvedAt) {
          rec.firstSolvedAt = ts;
        }
      }
    }

    const rows = Array.from(best.entries()).map(([player, v]) => ({ player, ...v }));
    rows.sort((a,b) => (a.bestTry - b.bestTry) || (a.firstSolvedAt - b.firstSolvedAt));

    if (rows.length === 0) {
      lbStatus && (lbStatus.textContent = "No solved attempts yet for this stage.");
      renderLeaderboard([]);
      return;
    }

    lbStatus && (lbStatus.textContent = `Found ${rows.length} solver(s).`);
    renderLeaderboard(rows);
  }

  // ====== Wire-up ======
  connectBtn  && (connectBtn.onclick  = connect);
  addChainBtn && (addChainBtn.onclick = addOrSwitch);
  submitBtn   && (submitBtn.onclick   = submitGuess);
  loadLbBtn   && (loadLbBtn.onclick   = async () => {
    try {
      await loadLeaderboardFor(lbDate ? lbDate.value : todayStr, lbStageEl ? lbStageEl.value : "1");
    } catch (e) {
      lbStatus && (lbStatus.innerHTML = `<span class="err">${e.message}</span>`);
    }
  });
