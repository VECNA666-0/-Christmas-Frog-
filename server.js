import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';

/** ── CONFIG (можно переопределять через ENV) ───────────────────────────── */
const TOKEN    = (process.env.TOKEN || '0xaD6a4F5AF2dAddE7801EAbEa764A7D4cF0EF7Cb3').toLowerCase();
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);
const AMOUNT   = BigInt(process.env.AMOUNT || 1000n);           // 1000 (без decimals)
const RPC_URL  = process.env.RPC_URL || 'https://polygon-rpc.com';
const PORT     = process.env.PORT || 8787;

// Разрешённые origin'ы для фронта (во время тестов можно оставить "*")
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/** ── APP ───────────────────────────────────────────────────────────────── */
const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS === '*' ? true : ALLOWED_ORIGINS }));
app.use(express.json({ limit: '512kb' }));

/** ── PROVIDER & WALLET ─────────────────────────────────────────────────── */
const RAW_PK = (process.env.PRIVATE_KEY || '').trim();
function isHexPk(v){ return /^0x[0-9a-fA-F]{64}$/.test(v); }

let wallet;
if (isHexPk(RAW_PK)) {
  wallet = new ethers.Wallet(RAW_PK);
} else if (RAW_PK.split(/\s+/).length >= 12) {
  // поддержка мнемоники (если вдруг положишь seed-фразу — НЕ рекомендую)
  wallet = ethers.Wallet.fromPhrase(RAW_PK);
} else {
  throw new Error('PRIVATE_KEY is invalid. Expected 0x + 64 hex or a 12/24-word phrase.');
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
wallet = wallet.connect(provider);

/** ── ERC20 интерфейс ───────────────────────────────────────────────────── */
const erc20 = new ethers.Contract(
  TOKEN,
  [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function transfer(address,uint256) returns (bool)'
  ],
  wallet
);

// читаем метаданные токена
const symbol   = await erc20.symbol().catch(() => 'TKN');
const decimals = await erc20.decimals().catch(() => 18);
const amountWei = ethers.parseUnits(String(AMOUNT), decimals);

/** ── REPLAY-защита (in-memory) ─────────────────────────────────────────── */
const usedNonces = new Set();

/** ── Хелперы ───────────────────────────────────────────────────────────── */
function ok(res, data){ return res.json({ ok: true, ...data }); }
function bad(res, error, code=400){ return res.status(code).json({ error }); }

/** ── Эндпоинты ─────────────────────────────────────────────────────────── */
app.get('/health', async (_req,res) => {
  const addr = await wallet.getAddress();
  return ok(res, { chainId: CHAIN_ID, token: TOKEN, symbol, decimals, sender: addr });
});

/**
 * Ожидает JSON:
 * { token, claimer, amount, nonce, deadline, signature }
 * Подпись — EIP-712. domain.name допускаем из набора (чтобы совпасть с разными фронтами).
 */
app.post('/api/claim', async (req, res) => {
  try {
    const { token, claimer, amount, nonce, deadline, signature } = req.body || {};

    if ((token||'').toLowerCase() !== TOKEN) return bad(res, 'Bad token');
    if (!ethers.isAddress(claimer))         return bad(res, 'Bad claimer');
    if (String(amount) !== amountWei.toString()) return bad(res, 'Bad amount');

    const now = Math.floor(Date.now()/1000);
    if (now > Number(deadline))             return bad(res, 'Expired');
    if (usedNonces.has(String(nonce)))      return bad(res, 'Nonce used');

    // принимаем разные названия домена, чтобы не споткнуться об фронт
    const domainNames = ['NY Airdrop','VEN Airdrop','Airdrop','Claim'];
    const types = {
      Claim: [
        { name:'claimer', type:'address' },
        { name:'amount',  type:'uint256' },
        { name:'nonce',   type:'uint256' },
        { name:'deadline',type:'uint256' }
      ]
    };
    const msg = { claimer, amount, nonce, deadline };

    let recoveredOk = false;
    for (const name of domainNames) {
      try {
        const domain = { name, version: '1', chainId: CHAIN_ID };
        const recovered = ethers.verifyTypedData(domain, types, msg, signature);
        if (recovered.toLowerCase() === claimer.toLowerCase()) { recoveredOk = true; break; }
      } catch (_) {}
    }
    if (!recoveredOk) return bad(res, 'Bad signature');

    // отправляем токены (газ платит кошелёк сервера)
    const tx = await erc20.transfer(claimer, amountWei);
    usedNonces.add(String(nonce));

    return ok(res, { txHash: tx.hash });
  } catch (e) {
    console.error(e);
    // типичные кейсы: insufficient funds / transfer amount exceeds balance
    return bad(res, e.shortMessage || e.message || 'Server error', 500);
  }
});

/** ── START ─────────────────────────────────────────────────────────────── */
app.listen(PORT, async () => {
  const addr = await wallet.getAddress().catch(()=>'');
  console.log(`Airdrop server on :${PORT}`);
  console.log(`Sender address: ${addr}`);
  console.log(`Token: ${TOKEN} (${symbol}, ${decimals}d), amount: ${AMOUNT} -> ${amountWei.toString()}`);
});
