import type {
  Account,
  Address,
  Hex,
  TypedDataDomain,
  WalletClient,
} from "viem";

export const ORDER_TYPES: Record<
  string,
  readonly { name: string; type: string }[]
>;
export const CANCEL_TYPES: Record<
  string,
  readonly { name: string; type: string }[]
>;

export function encodeType(
  primaryType: string,
  types: Record<string, readonly { name: string; type: string }[]>,
): string;

export function signErc7739TypedData(parameters: {
  walletClient: WalletClient;
  account: Account;
  appDomain: TypedDataDomain;
  contentsTypes: Record<
    string,
    readonly { name: string; type: string }[]
  >;
  primaryType: string;
  contents: Record<string, unknown>;
  depositWallet: Address;
}): Promise<Hex>;

export function signErc7739Order(parameters: {
  walletClient: WalletClient;
  account: Account;
  appDomain: TypedDataDomain;
  order: Record<string, unknown> & { maker: Address };
}): Promise<Hex>;
