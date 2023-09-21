// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

// interface
import { IERC20 } from "openzeppelin/interfaces/IERC20.sol";
import { IZenBullStrategy } from "./interface/IZenBullStrategy.sol";
import { IOracle } from "./interface/IOracle.sol";
import { IEulerSimpleLens } from "./interface/IEulerSimpleLens.sol";

library NettingLib {
    event TransferWethFromMarketMakers(
        address indexed trader,
        uint256 quantity,
        uint256 wethAmount,
        uint256 remainingOsqfuBalance,
        uint256 clearingPrice
    );
    event TransferOsqfuToMarketMakers(
        address indexed trader, uint256 bidId, uint256 quantity, uint256 remainingOsqfuBalance
    );
    event TransferOsqfuFromMarketMakers(
        address indexed trader, uint256 quantity, uint256 oSqfuRemaining
    );
    event TransferWethToMarketMaker(
        address indexed trader,
        uint256 bidId,
        uint256 quantity,
        uint256 wethAmount,
        uint256 oSqfuRemaining,
        uint256 clearingPrice
    );

    /**
     * @notice transfer WETH from market maker to netting contract
     * @dev this is executed during the deposit auction, MM buying OSQFU for WETH
     * @param _weth WETH address
     * @param _trader market maker address
     * @param _quantity oSQFU quantity
     * @param _oSqfuToMint remaining amount of the total oSqfuToMint
     * @param _clearingPrice auction clearing price
     */
    function transferWethFromMarketMakers(
        address _weth,
        address _trader,
        uint256 _quantity,
        uint256 _oSqfuToMint,
        uint256 _clearingPrice
    ) external returns (bool, uint256) {
        uint256 wethAmount;
        uint256 remainingOsqfuToMint;
        if (_quantity >= _oSqfuToMint) {
            wethAmount = (_oSqfuToMint * _clearingPrice) / 1e18;
            IERC20(_weth).transferFrom(_trader, address(this), wethAmount);

            emit TransferWethFromMarketMakers(
                _trader, _oSqfuToMint, wethAmount, remainingOsqfuToMint, _clearingPrice
            );
            return (true, remainingOsqfuToMint);
        } else {
            wethAmount = (_quantity * _clearingPrice) / 1e18;
            remainingOsqfuToMint = _oSqfuToMint - _quantity;
            IERC20(_weth).transferFrom(_trader, address(this), wethAmount);

            emit TransferWethFromMarketMakers(
                _trader, _quantity, wethAmount, remainingOsqfuToMint, _clearingPrice
            );
            return (false, remainingOsqfuToMint);
        }
    }

    /**
     * @notice transfer oSQFU to market maker
     * @dev this is executed during the deposit auction, MM buying OSQFU for WETH
     * @param _oSqfu oSQFU address
     * @param _trader market maker address
     * @param _bidId MM's bid ID
     * @param _oSqfuBalance remaining netting contracts's oSQFU balance
     * @param _quantity oSQFU quantity in market maker order
     */
    function transferOsqfuToMarketMakers(
        address _oSqfu,
        address _trader,
        uint256 _bidId,
        uint256 _oSqfuBalance,
        uint256 _quantity
    ) external returns (bool, uint256) {
        uint256 remainingOsqfuBalance;
        if (_quantity < _oSqfuBalance) {
            IERC20(_oSqfu).transfer(_trader, _quantity);

            remainingOsqfuBalance = _oSqfuBalance - _quantity;

            emit TransferOsqfuToMarketMakers(_trader, _bidId, _quantity, remainingOsqfuBalance);

            return (false, remainingOsqfuBalance);
        } else {
            IERC20(_oSqfu).transfer(_trader, _oSqfuBalance);

            emit TransferOsqfuToMarketMakers(_trader, _bidId, _oSqfuBalance, remainingOsqfuBalance);

            return (true, remainingOsqfuBalance);
        }
    }

    /**
     * @notice transfer oSQFU from market maker
     * @dev this is executed during the withdraw auction, MM selling OSQFU for WETH
     * @param _oSqfu oSQFU address
     * @param _trader market maker address
     * @param _remainingOsqfuToPull remaining amount of oSQFU from the total oSQFU amount to transfer from order array
     * @param _quantity oSQFU quantity in market maker order
     */
    function transferOsqfuFromMarketMakers(
        address _oSqfu,
        address _trader,
        uint256 _remainingOsqfuToPull,
        uint256 _quantity
    ) internal returns (uint256) {
        uint256 oSqfuRemaining;
        if (_quantity < _remainingOsqfuToPull) {
            IERC20(_oSqfu).transferFrom(_trader, address(this), _quantity);

            oSqfuRemaining = _remainingOsqfuToPull - _quantity;

            emit TransferOsqfuFromMarketMakers(_trader, _quantity, oSqfuRemaining);
        } else {
            IERC20(_oSqfu).transferFrom(_trader, address(this), _remainingOsqfuToPull);

            emit TransferOsqfuFromMarketMakers(_trader, _remainingOsqfuToPull, oSqfuRemaining);
        }

        return oSqfuRemaining;
    }

    /**
     * @notice transfer WETH to market maker
     * @dev this is executed during the withdraw auction, MM selling OSQFU for WETH
     * @param _weth WETH address
     * @param _trader market maker address
     * @param _bidId market maker bid ID
     * @param _remainingOsqfuToPull total oSQFU to get from orders array
     * @param _quantity market maker's oSQFU order quantity
     * @param _clearingPrice auction clearing price
     */
    function transferWethToMarketMaker(
        address _weth,
        address _trader,
        uint256 _bidId,
        uint256 _remainingOsqfuToPull,
        uint256 _quantity,
        uint256 _clearingPrice
    ) external returns (uint256) {
        uint256 oSqfuQuantity;

        if (_quantity < _remainingOsqfuToPull) {
            oSqfuQuantity = _quantity;
        } else {
            oSqfuQuantity = _remainingOsqfuToPull;
        }

        uint256 wethAmount = (oSqfuQuantity * _clearingPrice) / 1e18;
        _remainingOsqfuToPull -= oSqfuQuantity;
        IERC20(_weth).transfer(_trader, wethAmount);

        emit TransferWethToMarketMaker(
            _trader, _bidId, _quantity, wethAmount, _remainingOsqfuToPull, _clearingPrice
        );

        return _remainingOsqfuToPull;
    }

    /**
     * @notice get _crab token price
     * @param _oracle oracle address
     * @param _crab crab token address
     * @param _ethUsdcPool ETH/USDC Uni v3 pool address
     * @param _ethSquFuryPool ETH/oSQFU Uni v3 pool address
     * @param _oSqfu oSQFU address
     * @param _usdc USDC address
     * @param _weth WETH address
     * @param _zenBull ZenBull strategy address
     * @param _auctionTwapPeriod auction TWAP
     */
    function getCrabPrice(
        address _oracle,
        address _crab,
        address _ethUsdcPool,
        address _ethSquFuryPool,
        address _oSqfu,
        address _usdc,
        address _weth,
        address _zenBull,
        uint32 _auctionTwapPeriod
    ) external view returns (uint256, uint256) {
        uint256 squfuryEthPrice =
            IOracle(_oracle).getTwap(_ethSquFuryPool, _oSqfu, _weth, _auctionTwapPeriod, false);
        uint256 _ethUsdcPrice =
            IOracle(_oracle).getTwap(_ethUsdcPool, _weth, _usdc, _auctionTwapPeriod, false);
        (uint256 crabCollateral, uint256 crabDebt) =
            IZenBullStrategy(_zenBull).getCrabVaultDetails();
        uint256 _crabFairPriceInEth = (crabCollateral - (crabDebt * squfuryEthPrice / 1e18)) * 1e18
            / IERC20(_crab).totalSupply();

        return (_crabFairPriceInEth, _ethUsdcPrice);
    }

    /**
     * @notice get ZenBull token price
     * @param _zenBull ZenBull token address
     * @param _eulerLens EulerSimpleLens contract address
     * @param _usdc USDC address
     * @param _weth WETH address
     * @param _crabFairPriceInEth Crab token price
     * @param _ethUsdcPrice ETH/USDC price
     */
    function getZenBullPrice(
        address _zenBull,
        address _eulerLens,
        address _usdc,
        address _weth,
        uint256 _crabFairPriceInEth,
        uint256 _ethUsdcPrice
    ) external view returns (uint256) {
        uint256 zenBullCrabBalance = IZenBullStrategy(_zenBull).getCrabBalance();
        return (
            IEulerSimpleLens(_eulerLens).getETokenBalance(_weth, _zenBull)
                + (zenBullCrabBalance * _crabFairPriceInEth / 1e18)
                - (
                    (IEulerSimpleLens(_eulerLens).getDTokenBalance(_usdc, _zenBull) * 1e12 * 1e18)
                        / _ethUsdcPrice
                )
        ) * 1e18 / IERC20(_zenBull).totalSupply();
    }

    /**
     * @notice calculate oSQFU to mint and amount of eth to deposit into Crab v2 based on amount of crab token
     * @param _crab crab strategy address
     * @param _zenBull ZenBull strategy address
     * @param _crabAmount amount of crab token
     */
    function calcOsqfuToMintAndEthIntoCrab(address _crab, address _zenBull, uint256 _crabAmount)
        external
        view
        returns (uint256, uint256)
    {
        uint256 crabTotalSupply = IERC20(_crab).totalSupply();
        (uint256 crabEth, uint256 crabDebt) = IZenBullStrategy(_zenBull).getCrabVaultDetails();
        uint256 _oSqfuToMint = _crabAmount * crabDebt / crabTotalSupply;
        uint256 ethIntoCrab = _crabAmount * crabEth / crabTotalSupply;

        return (_oSqfuToMint, ethIntoCrab);
    }

    /**
     * @notice calculate amount of WETH to lend in and USDC to borrow from Euler
     * @param _eulerLens EulerSimpleLens contract address
     * @param _zenBull ZenBull strategy address
     * @param _weth WETH address
     * @param _usdc USDC address
     * @param _crabAmount amount of crab token
     */
    function calcWethToLendAndUsdcToBorrow(
        address _eulerLens,
        address _zenBull,
        address _weth,
        address _usdc,
        uint256 _crabAmount
    ) external view returns (uint256, uint256) {
        uint256 share =
            div(_crabAmount, (IZenBullStrategy(_zenBull).getCrabBalance() + _crabAmount));
        uint256 wethToLend = div(
            mul(IEulerSimpleLens(_eulerLens).getETokenBalance(_weth, _zenBull), share), 1e18 - share
        );
        uint256 usdcToBorrow = div(
            mul(IEulerSimpleLens(_eulerLens).getDTokenBalance(_usdc, _zenBull), share), 1e18 - share
        );

        return (wethToLend, usdcToBorrow);
    }

    /**
     * @notice calculate amount of oSQFU to get based on amount of ZenBull to Withdraw
     * @param _zenBull ZenBull strategy address
     * @param _crab crab strategy address
     * @param _withdrawsToProcess amount of ZenBull token to withdraw
     */
    function calcOsqfuAmount(address _zenBull, address _crab, uint256 _withdrawsToProcess)
        external
        view
        returns (uint256)
    {
        uint256 bullTotalSupply = IERC20(_zenBull).totalSupply();
        (, uint256 crabDebt) = IZenBullStrategy(_zenBull).getCrabVaultDetails();
        uint256 share = div(_withdrawsToProcess, bullTotalSupply);
        uint256 _crabAmount = mul(share, IZenBullStrategy(_zenBull).getCrabBalance());

        return div(mul(_crabAmount, crabDebt), IERC20(_crab).totalSupply());
    }

    function mul(uint256 _x, uint256 _y) internal pure returns (uint256) {
        // add(mul(_x, _y), WAD / 2) / WAD;
        return ((_x * _y) + (1e18 / 2)) / 1e18;
    }

    function div(uint256 _x, uint256 _y) internal pure returns (uint256) {
        // add(mul(_x, WAD), _y / 2) / _y;
        return ((_x * 1e18) + (_y / 2)) / _y;
    }
}
