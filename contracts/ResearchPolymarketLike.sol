// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC1271Like {
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4);
}

/// @notice Test-only 6-decimal collateral token, similar in role to pUSD.
contract ResearchMockUSD {
    string public constant name = "Research Mock USD";
    string public constant symbol = "rUSD";
    uint8 public constant decimals = 6;

    address public immutable owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool)
    {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Test-only wallet coin. This is the user's own research payment token.
contract ResearchWalletCoin {
    string public constant name = "Research Wallet Coin";
    string public constant symbol = "rWALLET";
    uint8 public constant decimals = 6;

    address public immutable owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool)
    {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Test-only outcome token, ERC-1155-like enough for exchange research.
contract ResearchOutcomeToken {
    address public immutable owner;

    mapping(uint256 => mapping(address => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);

    error NotApproved();
    error InsufficientBalance();
    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id, uint256 amount)
        external
    {
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) {
            revert NotApproved();
        }
        uint256 balance = balanceOf[id][from];
        if (balance < amount) revert InsufficientBalance();
        balanceOf[id][from] = balance - amount;
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }
}

/// @notice Research-only market event publisher that emits Polymarket-like market publication events.
contract ResearchMarketRegistry {
    enum MarketStatus {
        OPEN,
        CLOSED,
        RESOLVED
    }

    struct Market {
        bytes32 marketId;
        address creator;
        string question;
        uint256 yesTokenId;
        uint256 noTokenId;
        uint64 closeTime;
        MarketStatus status;
        uint8 winningOutcome; // 0 = unresolved, 1 = YES, 2 = NO
    }

    ResearchWalletCoin public immutable walletCoin;
    ResearchOutcomeToken public immutable outcome;
    address public operator;
    uint256 public marketCount;
    mapping(bytes32 => Market) public markets;

    event MarketPublished(
        bytes32 indexed marketId,
        address indexed creator,
        string question,
        uint256 yesTokenId,
        uint256 noTokenId,
        uint64 closeTime
    );
    event TradeExecuted(
        bytes32 indexed marketId,
        address indexed buyer,
        address indexed seller,
        uint256 tokenId,
        uint256 outcomeAmount,
        uint256 walletCoinAmount
    );
    event MarketClosed(bytes32 indexed marketId);
    event MarketResolved(bytes32 indexed marketId, uint8 winningOutcome);

    error NotOperator();
    error NotCreatorOrOperator();
    error MarketAlreadyExists();
    error UnknownMarket();
    error MarketNotOpen();
    error AlreadyResolved();
    error InvalidOutcome();

    constructor(address walletCoin_, address outcome_) {
        walletCoin = ResearchWalletCoin(walletCoin_);
        outcome = ResearchOutcomeToken(outcome_);
        operator = msg.sender;
    }

    function nextMarket(
        address creator,
        string calldata question,
        uint64 closeTime
    )
        public
        view
        returns (bytes32 marketId, uint256 yesTokenId, uint256 noTokenId)
    {
        marketId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                creator,
                marketCount,
                question,
                closeTime
            )
        );
        yesTokenId = uint256(keccak256(abi.encode(marketId, "YES")));
        noTokenId = uint256(keccak256(abi.encode(marketId, "NO")));
    }

    function publishMarket(string calldata question, uint64 closeTime)
        external
        returns (bytes32 marketId, uint256 yesTokenId, uint256 noTokenId)
    {
        (marketId, yesTokenId, noTokenId) =
            nextMarket(msg.sender, question, closeTime);
        if (markets[marketId].creator != address(0)) revert MarketAlreadyExists();
        marketCount += 1;
        markets[marketId] = Market({
            marketId: marketId,
            creator: msg.sender,
            question: question,
            yesTokenId: yesTokenId,
            noTokenId: noTokenId,
            closeTime: closeTime,
            status: MarketStatus.OPEN,
            winningOutcome: 0
        });

        emit MarketPublished(
            marketId,
            msg.sender,
            question,
            yesTokenId,
            noTokenId,
            closeTime
        );
    }

    function closeMarket(bytes32 marketId) external {
        Market storage market = markets[marketId];
        if (market.creator == address(0)) revert UnknownMarket();
        if (msg.sender != market.creator && msg.sender != operator) {
            revert NotCreatorOrOperator();
        }
        if (market.status != MarketStatus.OPEN) revert MarketNotOpen();
        market.status = MarketStatus.CLOSED;
        emit MarketClosed(marketId);
    }

    function resolveMarket(bytes32 marketId, uint8 winningOutcome) external {
        Market storage market = markets[marketId];
        if (market.creator == address(0)) revert UnknownMarket();
        if (msg.sender != market.creator && msg.sender != operator) {
            revert NotCreatorOrOperator();
        }
        if (market.status == MarketStatus.RESOLVED) revert AlreadyResolved();
        if (winningOutcome != 1 && winningOutcome != 2) revert InvalidOutcome();

        market.status = MarketStatus.RESOLVED;
        market.winningOutcome = winningOutcome;
        emit MarketResolved(marketId, winningOutcome);
    }

    function simulateTrade(
        bytes32 marketId,
        address buyer,
        address seller,
        uint256 tokenId,
        uint256 outcomeAmount,
        uint256 walletCoinAmount
    ) external {
        if (msg.sender != operator) revert NotOperator();
        Market storage market = markets[marketId];
        if (market.creator == address(0)) revert UnknownMarket();
        if (market.status != MarketStatus.OPEN) revert MarketNotOpen();
        if (market.closeTime != 0 && block.timestamp > market.closeTime) {
            revert MarketNotOpen();
        }

        walletCoin.transferFrom(buyer, seller, walletCoinAmount);
        outcome.transferFrom(seller, buyer, tokenId, outcomeAmount);

        emit TradeExecuted(
            marketId,
            buyer,
            seller,
            tokenId,
            outcomeAmount,
            walletCoinAmount
        );
    }
}

/// @notice Deterministic test Deposit Wallet. Not a Polymarket official wallet.
contract ResearchDepositWallet {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable owner;
    uint256 public nonce;

    event BatchExecuted(uint256 indexed nonce, uint256 callCount);

    error InvalidOwner();
    error NotOwner();
    error CallFailed(uint256 index, bytes reason);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    receive() external payable {}

    function executeBatch(Call[] calldata calls)
        external
        payable
        returns (bytes[] memory results)
    {
        if (msg.sender != owner) revert NotOwner();
        uint256 currentNonce = nonce++;
        uint256 length = calls.length;
        results = new bytes[](length);
        for (uint256 i; i < length; ++i) {
            (bool success, bytes memory result) =
                calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert CallFailed(i, result);
            results[i] = result;
        }
        emit BatchExecuted(currentNonce, length);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        if (_recover(hash, signature) == owner) return ERC1271_MAGIC_VALUE;
        return 0xffffffff;
    }

    function _recover(bytes32 hash, bytes calldata signature)
        internal
        pure
        returns (address)
    {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}

contract ResearchDepositWalletFactory {
    event WalletCreated(address indexed wallet, address indexed owner, bytes32 indexed salt);

    function createWallet(address owner, bytes32 salt)
        external
        returns (address wallet)
    {
        bytes32 finalSalt = keccak256(abi.encode(owner, salt));
        wallet = getWallet(owner, salt);
        if (wallet.code.length == 0) {
            wallet = address(new ResearchDepositWallet{salt: finalSalt}(owner));
            emit WalletCreated(wallet, owner, salt);
        }
    }

    function getWallet(address owner, bytes32 salt) public view returns (address) {
        bytes32 finalSalt = keccak256(abi.encode(owner, salt));
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(
                type(ResearchDepositWallet).creationCode,
                abi.encode(owner)
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), finalSalt, bytecodeHash)
                    )
                )
            )
        );
    }
}

/// @notice Minimal operator-driven order matching inspired by CLOB settlement.
contract ResearchCLOBExchange {
    enum Side {
        BUY,
        SELL
    }

    struct Order {
        address maker; // wallet holding funds/assets
        address signer; // wallet/EOA that validates the signature
        uint256 tokenId;
        uint256 makerAmount; // BUY: rUSD offered. SELL: outcome tokens offered.
        uint256 takerAmount; // BUY: outcome wanted. SELL: rUSD wanted.
        Side side;
        uint256 expiration;
        uint256 salt;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint256 expiration,uint256 salt)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 orderHash)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    ResearchMockUSD public immutable collateral;
    ResearchOutcomeToken public immutable outcome;
    address public operator;

    mapping(bytes32 => uint256) public filledMakerAmount;
    mapping(bytes32 => bool) public cancelled;

    event OperatorChanged(address indexed operator);
    event OrdersMatched(
        bytes32 indexed buyHash,
        bytes32 indexed sellHash,
        address indexed buyer,
        address seller,
        uint256 tokenId,
        uint256 outcomeAmount,
        uint256 collateralAmount
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker, address indexed signer);

    error NotOperator();
    error InvalidSide();
    error TokenMismatch();
    error PriceDoesNotCross();
    error OrderExpired();
    error InvalidSignature();
    error Overfill();
    error OrderCancelledAlready();
    error ZeroFill();

    constructor(address collateral_, address outcome_, address operator_) {
        collateral = ResearchMockUSD(collateral_);
        outcome = ResearchOutcomeToken(outcome_);
        operator = operator_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ResearchCLOBExchange")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        emit OperatorChanged(operator_);
    }

    function setOperator(address operator_) external {
        if (msg.sender != operator) revert NotOperator();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function hashOrder(Order memory order) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.maker,
                order.signer,
                order.tokenId,
                order.makerAmount,
                order.takerAmount,
                order.side,
                order.expiration,
                order.salt
            )
        );
    }

    function digestOrder(Order memory order) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, hashOrder(order)));
    }

    function digestCancel(bytes32 orderHash) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, orderHash));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function cancelOrder(Order calldata order, bytes calldata cancelSignature) external {
        bytes32 orderHash = hashOrder(order);
        if (cancelled[orderHash]) revert OrderCancelledAlready();
        if (!_isValidSignature(order.signer, digestCancel(orderHash), cancelSignature)) {
            revert InvalidSignature();
        }
        cancelled[orderHash] = true;
        emit OrderCancelled(orderHash, order.maker, order.signer);
    }

    function remainingMakerAmount(Order memory order) public view returns (uint256) {
        bytes32 orderHash = hashOrder(order);
        if (cancelled[orderHash]) return 0;
        uint256 filled = filledMakerAmount[orderHash];
        if (filled >= order.makerAmount) return 0;
        return order.makerAmount - filled;
    }

    function matchOrders(
        Order calldata buy,
        bytes calldata buySignature,
        Order calldata sell,
        bytes calldata sellSignature
    ) external {
        _matchOrders(buy, buySignature, sell, sellSignature, sell.makerAmount);
    }

    function matchOrders(
        Order calldata buy,
        bytes calldata buySignature,
        Order calldata sell,
        bytes calldata sellSignature,
        uint256 outcomeAmount
    ) external {
        _matchOrders(buy, buySignature, sell, sellSignature, outcomeAmount);
    }

    function _matchOrders(
        Order calldata buy,
        bytes calldata buySignature,
        Order calldata sell,
        bytes calldata sellSignature,
        uint256 outcomeAmount
    ) internal {
        if (msg.sender != operator) revert NotOperator();
        if (buy.side != Side.BUY || sell.side != Side.SELL) revert InvalidSide();
        if (buy.tokenId != sell.tokenId) revert TokenMismatch();
        if (outcomeAmount == 0) revert ZeroFill();
        if (buy.expiration != 0 && block.timestamp > buy.expiration) revert OrderExpired();
        if (sell.expiration != 0 && block.timestamp > sell.expiration) revert OrderExpired();

        bytes32 buyDigest = digestOrder(buy);
        bytes32 sellDigest = digestOrder(sell);
        if (!_isValidSignature(buy.signer, buyDigest, buySignature)) revert InvalidSignature();
        if (!_isValidSignature(sell.signer, sellDigest, sellSignature)) revert InvalidSignature();

        bytes32 buyHash = hashOrder(buy);
        bytes32 sellHash = hashOrder(sell);
        if (cancelled[buyHash] || cancelled[sellHash]) revert OrderCancelledAlready();

        // SELL price determines the actual settlement amount, like a maker ask.
        uint256 collateralAmount = (outcomeAmount * sell.takerAmount) / sell.makerAmount;
        if (collateralAmount == 0) revert ZeroFill();

        // BUY pays makerAmount collateral for takerAmount outcomes.
        // SELL receives takerAmount collateral for makerAmount outcomes.
        if (outcomeAmount * buy.makerAmount < collateralAmount * buy.takerAmount) {
            revert PriceDoesNotCross();
        }

        uint256 nextBuyFilled = filledMakerAmount[buyHash] + collateralAmount;
        uint256 nextSellFilled = filledMakerAmount[sellHash] + outcomeAmount;
        if (nextBuyFilled > buy.makerAmount || nextSellFilled > sell.makerAmount) revert Overfill();
        filledMakerAmount[buyHash] = nextBuyFilled;
        filledMakerAmount[sellHash] = nextSellFilled;

        collateral.transferFrom(buy.maker, sell.maker, collateralAmount);
        outcome.transferFrom(sell.maker, buy.maker, sell.tokenId, outcomeAmount);

        emit OrdersMatched(
            buyHash,
            sellHash,
            buy.maker,
            sell.maker,
            sell.tokenId,
            outcomeAmount,
            collateralAmount
        );
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            try IERC1271Like(signer).isValidSignature(digest, signature) returns (bytes4 magic) {
                return magic == 0x1626ba7e;
            } catch {
                return false;
            }
        }
        return _recover(digest, signature) == signer;
    }

    function _recover(bytes32 hash, bytes calldata signature)
        internal
        pure
        returns (address)
    {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
