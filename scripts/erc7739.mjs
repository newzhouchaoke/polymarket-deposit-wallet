import {
  concatHex,
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  numberToHex,
  stringToHex,
} from "viem";

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
};

export const CANCEL_TYPES = {
  Cancel: [{ name: "orderHash", type: "bytes32" }],
};

const TYPED_DATA_SIGN_FIELDS = [
  { name: "contents", type: "__CONTENTS__" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

function baseType(type) {
  return type.replace(/\[[^\]]*\]/g, "");
}

/**
 * Returns the canonical EIP-712 type description used by ERC-7739.
 */
export function encodeType(primaryType, types) {
  const dependencies = new Set();
  const visit = (typeName) => {
    if (dependencies.has(typeName) || !types[typeName]) return;
    dependencies.add(typeName);
    for (const field of types[typeName]) visit(baseType(field.type));
  };
  visit(primaryType);
  const ordered = [
    primaryType,
    ...[...dependencies].filter((name) => name !== primaryType).sort(),
  ];
  return ordered
    .map((name) => {
      const fields = types[name]
        .map((field) => `${field.type} ${field.name}`)
        .join(",");
      return `${name}(${fields})`;
    })
    .join("");
}

/**
 * Signs and wraps an application EIP-712 object for a Deposit Wallet.
 *
 * Layout:
 * ownerSignature || appDomainSeparator || contentsHash ||
 * contentsDescription || uint16(contentsDescription.length)
 */
export async function signErc7739TypedData({
  walletClient,
  account,
  appDomain,
  contentsTypes,
  primaryType,
  contents,
  depositWallet,
}) {
  const typedDataSign = TYPED_DATA_SIGN_FIELDS.map((field) =>
    field.name === "contents"
      ? { ...field, type: primaryType }
      : field,
  );
  const nestedTypes = {
    ...contentsTypes,
    TypedDataSign: typedDataSign,
  };
  const zeroSalt = `0x${"00".repeat(32)}`;
  const ownerSignature = await walletClient.signTypedData({
    account,
    domain: appDomain,
    types: nestedTypes,
    primaryType: "TypedDataSign",
    message: {
      contents,
      name: "DepositWallet",
      version: "1",
      chainId: BigInt(appDomain.chainId),
      verifyingContract: depositWallet,
      salt: zeroSalt,
    },
  });

  const domainSeparator = hashDomain({
    domain: appDomain,
    types: {
      EIP712Domain: getTypesForEIP712Domain({ domain: appDomain }),
    },
  });
  const contentsHash = hashStruct({
    data: contents,
    primaryType,
    types: contentsTypes,
  });
  const contentsDescription = encodeType(primaryType, contentsTypes);
  const descriptionBytes = stringToHex(contentsDescription);
  const descriptionLength = Buffer.byteLength(contentsDescription, "utf8");
  if (descriptionLength === 0 || descriptionLength > 0xffff) {
    throw new Error("ERC-7739 contentsDescription 长度无效");
  }

  return concatHex([
    ownerSignature,
    domainSeparator,
    contentsHash,
    descriptionBytes,
    numberToHex(descriptionLength, { size: 2 }),
  ]);
}

export function signErc7739Order({
  walletClient,
  account,
  appDomain,
  order,
}) {
  return signErc7739TypedData({
    walletClient,
    account,
    appDomain,
    contentsTypes: ORDER_TYPES,
    primaryType: "Order",
    contents: order,
    depositWallet: order.maker,
  });
}
