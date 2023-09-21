// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity =0.7.6;

//interface
import {IOracle} from "../interfaces/IOracle.sol";

//lib
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

library Power2Base {
    using SafeMath for uint256;

    uint32 private constant TWAP_PERIOD = 420 seconds;
    uint256 private constant INDEX_SCALE = 1e4;
    uint256 private constant ONE = 1e18;
    uint256 private constant ONE_ONE = 1e36;

    /**
     * @notice return the scaled down index of the power perp in USD, scaled by 18 decimals
     * @param _period period of time for the twap in seconds (cannot be longer than maximum period for the pool)
     * @param _oracle oracle address
     * @param _ethQuoteCurrencyPool uniswap v3 pool for weth / quoteCurrency
     * @param _weth weth address
     * @param _quoteCurrency quoteCurrency address
     * @return for squfury, return ethPrice^2
     */
    function _getIndex(
        uint32 _period,
        address _oracle,
        address _ethQuoteCurrencyPool,
        address _weth,
        address _quoteCurrency
    ) internal view returns (uint256) {
        uint256 ethQuoteCurrencyPrice = _getScaledTwap(
            _oracle,
            _ethQuoteCurrencyPool,
            _weth,
            _quoteCurrency,
            _period,
            false
        );
        return ethQuoteCurrencyPrice.mul(ethQuoteCurrencyPrice).div(ONE);
    }

    /**
     * @notice return the unscaled index of the power perp in USD, scaled by 18 decimals
     * @param _period period of time for the twap in seconds (cannot be longer than maximum period for the pool)
     * @param _oracle oracle address
     * @param _ethQuoteCurrencyPool uniswap v3 pool for weth / quoteCurrency
     * @param _weth weth address
     * @param _quoteCurrency quoteCurrency address
     * @return for squfury, return ethPrice^2
     */
    function _getUnscaledIndex(
        uint32 _period,
        address _oracle,
        address _ethQuoteCurrencyPool,
        address _weth,
        address _quoteCurrency
    ) internal view returns (uint256) {
        uint256 ethQuoteCurrencyPrice = _getTwap(_oracle, _ethQuoteCurrencyPool, _weth, _quoteCurrency, _period, false);
        return ethQuoteCurrencyPrice.mul(ethQuoteCurrencyPrice).div(ONE);
    }

    /**
     * @notice return the mark price of power perp in quoteCurrency, scaled by 18 decimals
     * @param _period period of time for the twap in seconds (cannot be longer than maximum period for the pool)
     * @param _oracle oracle address
     * @param _wSquFuryEthPool uniswap v3 pool for wSquFury / weth
     * @param _ethQuoteCurrencyPool uniswap v3 pool for weth / quoteCurrency
     * @param _weth weth address
     * @param _quoteCurrency quoteCurrency address
     * @param _wSquFury wSquFury address
     * @param _normalizationFactor current normalization factor
     * @return for squfury, return ethPrice * squfuryPriceInEth
     */
    function _getDenormalizedMark(
        uint32 _period,
        address _oracle,
        address _wSquFuryEthPool,
        address _ethQuoteCurrencyPool,
        address _weth,
        address _quoteCurrency,
        address _wSquFury,
        uint256 _normalizationFactor
    ) internal view returns (uint256) {
        uint256 ethQuoteCurrencyPrice = _getScaledTwap(
            _oracle,
            _ethQuoteCurrencyPool,
            _weth,
            _quoteCurrency,
            _period,
            false
        );
        uint256 wsqufuryEthPrice = _getTwap(_oracle, _wSquFuryEthPool, _wSquFury, _weth, _period, false);

        return wsqufuryEthPrice.mul(ethQuoteCurrencyPrice).div(_normalizationFactor);
    }

    /**
     * @notice get the fair collateral value for a _debtAmount of wSquFury
     * @dev the actual amount liquidator can get should have a 10% bonus on top of this value.
     * @param _debtAmount wSquFury amount paid by liquidator
     * @param _oracle oracle address
     * @param _wSquFuryEthPool uniswap v3 pool for wSquFury / weth
     * @param _wSquFury wSquFury address
     * @param _weth weth address
     * @return returns value of debt in ETH
     */
    function _getDebtValueInEth(
        uint256 _debtAmount,
        address _oracle,
        address _wSquFuryEthPool,
        address _wSquFury,
        address _weth
    ) internal view returns (uint256) {
        uint256 wSquFuryPrice = _getTwap(_oracle, _wSquFuryEthPool, _wSquFury, _weth, TWAP_PERIOD, false);
        return _debtAmount.mul(wSquFuryPrice).div(ONE);
    }

    /**
     * @notice request twap from our oracle, scaled down by INDEX_SCALE
     * @param _oracle oracle address
     * @param _pool uniswap v3 pool address
     * @param _base base currency. to get eth/usd price, eth is base token
     * @param _quote quote currency. to get eth/usd price, usd is the quote currency
     * @param _period number of seconds in the past to start calculating time-weighted average.
     * @param _checkPeriod check that period is not longer than maximum period for the pool to prevent reverts
     * @return twap price scaled down by INDEX_SCALE
     */
    function _getScaledTwap(
        address _oracle,
        address _pool,
        address _base,
        address _quote,
        uint32 _period,
        bool _checkPeriod
    ) internal view returns (uint256) {
        uint256 twap = _getTwap(_oracle, _pool, _base, _quote, _period, _checkPeriod);
        return twap.div(INDEX_SCALE);
    }

    /**
     * @notice request twap from our oracle
     * @dev this will revert if period is > max period for the pool
     * @param _oracle oracle address
     * @param _pool uniswap v3 pool address
     * @param _base base currency. to get eth/quoteCurrency price, eth is base token
     * @param _quote quote currency. to get eth/quoteCurrency price, quoteCurrency is the quote currency
     * @param _period number of seconds in the past to start calculating time-weighted average
     * @param _checkPeriod check that period is not longer than maximum period for the pool to prevent reverts
     * @return human readable price. scaled by 1e18
     */
    function _getTwap(
        address _oracle,
        address _pool,
        address _base,
        address _quote,
        uint32 _period,
        bool _checkPeriod
    ) internal view returns (uint256) {
        // period reaching this point should be check, otherwise might revert
        return IOracle(_oracle).getTwap(_pool, _base, _quote, _period, _checkPeriod);
    }

    /**
     * @notice get the index value of wsqufury in wei, used when system settles
     * @dev the index of squfury is ethPrice^2, so each squfury will need to pay out {ethPrice} eth
     * @param _wsqufuryAmount amount of wsqufury used in settlement
     * @param _indexPriceForSettlement index price for settlement
     * @param _normalizationFactor current normalization factor
     * @return amount in wei that should be paid to the token holder
     */
    function _getLongSettlementValue(
        uint256 _wsqufuryAmount,
        uint256 _indexPriceForSettlement,
        uint256 _normalizationFactor
    ) internal pure returns (uint256) {
        return _wsqufuryAmount.mul(_normalizationFactor).mul(_indexPriceForSettlement).div(ONE_ONE);
    }
}
