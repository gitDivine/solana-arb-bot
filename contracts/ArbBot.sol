// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}

interface IAavePool {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

interface IAerodromeRouter {
    struct Route { address from; address to; bool stable; address factory; }
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

interface IAlgebraRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; address recipient; uint256 deadline;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ArbBot is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
    IAavePool  public immutable AAVE_POOL;
    address    public immutable USDC;

    enum DexType { UNISWAP_V2, UNISWAP_V3, SOLIDLY, ALGEBRA }

    struct SwapLeg {
        address router;
        DexType dexType;
        uint24 fee;     // For V3
        bool stable;    // For Solidly
        address factory; // For Solidly
    }

    event ArbitrageExecuted(address tokenOut, uint256 profit, address router1, address router2);
    event ProfitWithdrawn(address token, uint256 amount);

    constructor(address _pool, address _usdc) Ownable(msg.sender) {
        AAVE_POOL = IAavePool(_pool);
        USDC = _usdc;
    }

    function startArbitrage(
        address tokenOut, 
        uint256 flashAmount, 
        SwapLeg calldata leg1, 
        SwapLeg calldata leg2, 
        uint256 minProfitUsdc
    ) external onlyOwner {
        bytes memory params = abi.encode(tokenOut, leg1, leg2, minProfitUsdc);
        AAVE_POOL.flashLoanSimple(address(this), USDC, flashAmount, params, 0);
    }

    function executeOperation(
        address, 
        uint256 amount, 
        uint256 premium, 
        address initiator, 
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        require(msg.sender == address(AAVE_POOL), "Untrusted caller");
        require(initiator == address(this), "Untrusted initiator");

        (address tokenOut, SwapLeg memory leg1, SwapLeg memory leg2, uint256 minProfitUsdc) = abi.decode(params, (address, SwapLeg, SwapLeg, uint256));
        
        uint256 repayAmount = amount + premium;
        
        // Step 1: Buy tokenOut with USDC using Leg 1
        uint256 tokenAmount = _swap(leg1, USDC, tokenOut, amount);
        
        // Step 2: Sell tokenOut back to USDC using Leg 2
        uint256 finalUsdc = _swap(leg2, tokenOut, USDC, tokenAmount);

        require(finalUsdc >= repayAmount, "Cannot repay loan");
        uint256 profit = finalUsdc - repayAmount;
        require(profit >= minProfitUsdc, "Insufficient profit");
        
        IERC20(USDC).approve(address(AAVE_POOL), repayAmount);
        
        emit ArbitrageExecuted(tokenOut, profit, leg1.router, leg2.router);
        return true;
    }

    function _swap(SwapLeg memory leg, address from, address to, uint256 amountIn) internal returns (uint256) {
        IERC20(from).approve(leg.router, amountIn);

        if (leg.dexType == DexType.UNISWAP_V3) {
            return IUniswapV3Router(leg.router).exactInputSingle(IUniswapV3Router.ExactInputSingleParams({
                tokenIn: from,
                tokenOut: to,
                fee: leg.fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            }));
        } 
        else if (leg.dexType == DexType.ALGEBRA) {
            return IAlgebraRouter(leg.router).exactInputSingle(IAlgebraRouter.ExactInputSingleParams({
                tokenIn: from,
                tokenOut: to,
                recipient: address(this),
                deadline: block.timestamp + 60,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            }));
        }
        else if (leg.dexType == DexType.SOLIDLY) {
            IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
            routes[0] = IAerodromeRouter.Route({ 
                from: from, 
                to: to, 
                stable: leg.stable,
                factory: leg.factory
            });
            uint256[] memory amounts = IAerodromeRouter(leg.router).swapExactTokensForTokens(
                amountIn, 0, routes, address(this), block.timestamp + 60
            );
            return amounts[amounts.length - 1];
        }
        else { // UNISWAP_V2
            address[] memory path = new address[](2);
            path[0] = from;
            path[1] = to;
            uint256[] memory amounts = IUniswapV2Router(leg.router).swapExactTokensForTokens(
                amountIn, 0, path, address(this), block.timestamp + 60
            );
            return amounts[amounts.length - 1];
        }
    }

    function sweep(address token) external onlyOwner nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to sweep");
        IERC20(token).transfer(owner(), bal);
        emit ProfitWithdrawn(token, bal);
    }

    function withdrawToken(address token) external onlyOwner nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        IERC20(token).transfer(owner(), bal);
        emit ProfitWithdrawn(token, bal);
    }

    function withdrawEth() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
