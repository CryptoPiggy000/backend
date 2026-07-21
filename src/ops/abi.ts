import { parseAbi, parseAbiItem } from "viem";

// ── Events we index (from AccountFactory + ProtocolRegistry) ──────────────────────────────────
// AccountFactory: one per user opening an account (owner ↔ account).
export const AccountCreated = parseAbiItem(
  "event AccountCreated(address indexed owner, address indexed account, bytes32 salt)",
);
// ProtocolRegistry: base-asset principal moving IN (deposit or buy) / OUT (withdraw or sell-back).
// `amount` is the flow, `netDeployed` the running global net principal after it.
export const Deployed = parseAbiItem(
  "event Deployed(address indexed account, uint256 amount, uint256 netDeployed)",
);
export const Returned = parseAbiItem(
  "event Returned(address indexed account, uint256 amount, uint256 netDeployed)",
);
// SmartInvestmentAccount (each clone): the entry fee skimmed on a savings deposit → revenue.
export const DepositFeePaid = parseAbiItem(
  "event DepositFeePaid(bytes32 indexed positionId, address indexed collector, uint256 fee)",
);

// ── Read ABIs for the value pass ──────────────────────────────────────────────────────────────
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const erc4626Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

// Mock Aave pool (anvil) exposes the user's supplied principal directly. On Base we read the aToken
// balance instead (via the ATOKENS config) — so this is only the local/no-aToken fallback.
export const aavePoolAbi = parseAbi([
  "function supplied(address user, address asset) view returns (uint256)",
]);

// Chainlink USD price feed (Base). `answer` is priced in `decimals()` dp (8 for USD feeds).
export const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

// ProtocolRegistry — enumerate positions + the base asset. (There is no on-chain asset enumeration, so
// held-asset tokens are supplied via the HELD_ASSETS config.)
export const registryAbi = parseAbi([
  "function allPositionIds() view returns (bytes32[])",
  "function getProtocol(bytes32) view returns ((uint8 adapterType, address target, address asset, bytes32 category, uint8 status))",
  "function baseAsset() view returns (address)",
]);

// AdapterType enum (Types.sol): NONE=0, ERC4626=1, AAVE=2.
export const ADAPTER = { ERC4626: 1, AAVE: 2 } as const;
