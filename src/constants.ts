import type { Address } from "viem";

export const AMOY_CHAIN_ID = 80002;

export const ADDRESSES = {
  pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  ctf: "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB",
  ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchange: "0xe2222d279d744050d28e00520010520000310F59",
  depositWalletFactory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
} as const satisfies Record<string, Address>;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const ERC1155_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
