import { ethers } from "hardhat"
import { expect } from "chai";
import { parseEther } from "ethers/lib/utils";
import { BigNumber } from "ethers";
import { MockWPowerPerp, MockUniswapV3Pool, MockErc20, MockUniPositionManager, VaultLibTester } from "../../typechain";
import { getSqrtPriceAndTickBySquFuryPrice, getYAmountAboveRange, getXAmountBelowRange } from "../calculator";
import { isSimilar, one, oracleScaleFactor } from "../utils";


describe("VaultLib", function () {
  let squfury: MockWPowerPerp;
  let vaultLib: VaultLibTester
  let squfuryEthPool: MockUniswapV3Pool;
  let uniPositionManager: MockUniPositionManager
  let weth: MockErc20;
  let wethIsToken0: boolean

  this.beforeAll("Setup environment", async () => {
    const MockSQUContract = await ethers.getContractFactory("MockWPowerPerp");
    squfury = (await MockSQUContract.deploy()) as MockWPowerPerp;

    const MockErc20Contract = await ethers.getContractFactory("MockErc20");
    weth = (await MockErc20Contract.deploy("WETH", "WETH", 18)) as MockErc20;

    const MockUniswapV3PoolContract = await ethers.getContractFactory("MockUniswapV3Pool");
    squfuryEthPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;

    const MockPositionManager = await ethers.getContractFactory("MockUniPositionManager");
    uniPositionManager = (await MockPositionManager.deploy()) as MockUniPositionManager;

    // set token0 and token1 for squfury/eth pool
    wethIsToken0 = parseInt(weth.address, 16) < parseInt(squfury.address, 16)
    if (wethIsToken0) {
      await squfuryEthPool.setPoolTokens(weth.address, squfury.address);
    } else {
      await squfuryEthPool.setPoolTokens(squfury.address, weth.address);
    }
  });

  this.beforeAll("Deploy VaultLibTester", async () => {

    const SqrtPriceExternal = await ethers.getContractFactory("SqrtPriceMathPartial")
    const SqrtPriceExternalLibrary = (await SqrtPriceExternal.deploy());

    const TickMathExternal = await ethers.getContractFactory("TickMathExternal")
    const TickMathLibrary = (await TickMathExternal.deploy());

    const VaultTester = await ethers.getContractFactory("VaultLibTester", {libraries: {TickMathExternal: TickMathLibrary.address, SqrtPriceMathPartial: SqrtPriceExternalLibrary.address}});
    vaultLib = (await VaultTester.deploy()) as VaultLibTester;
  })

  describe("#getUniPositionBalances tests", function () {
    let token0: string
    let token1: string

    describe('case: infinite range, price is always within range', async() => {
      const nftTokenId = 1
      const ethPrice = BigNumber.from('3000').mul(one)
      const scaledSquFuryEthPrice = ethPrice.div(oracleScaleFactor)
      let currentSqrtX96Price: string
      let currentTick: string
      const wsqufuryLiquidityAmount = parseEther('10')
      const ethLiquidityAmount = parseEther('3')

      before('calculate shared variables', async( )=> {
        token0 = wethIsToken0 ? weth.address : squfury.address
        token1 = wethIsToken0 ? squfury.address : weth.address
      })

      before('calculate prices', async() => {
        const { sqrtPrice, tick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryEthPrice, wethIsToken0)
        currentSqrtX96Price = sqrtPrice
        currentTick = tick
      })

      before('set lp token properties, assuming entered when price is 3000', async () => {
        // infinite nft ticks
        const nftTickUpper = 887220
        const nftTickLower = -887220

        const liquidity = await vaultLib.getLiquidity(
          currentSqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0 ? ethLiquidityAmount : wsqufuryLiquidityAmount,
          wethIsToken0 ? wsqufuryLiquidityAmount: ethLiquidityAmount,
        )
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)
      })

      before('set initial price', async() => {
        await squfuryEthPool.setSlot0Data(currentSqrtX96Price, currentTick)
      })

      it('should get the squfury / eth amount similar to our deposit amount', async() => {        
        const result = await vaultLib.getUniPositionBalances(uniPositionManager.address, nftTokenId, currentTick, wethIsToken0)
        // about 0.001 squfury
        expect(isSimilar(result.wPowerPerpAmount.toString(), wsqufuryLiquidityAmount.toString())).to.be.true
        // about 3 eth
        expect(isSimilar(result.ethAmount.toString(), ethLiquidityAmount.toString())).to.be.true
      })

      it('should get the correct squfury / eth amount after price changes', async() => {
        const newPrice = BigNumber.from('5000')
        const newScaledSquFuryPrice = newPrice.mul(one).div(oracleScaleFactor)
        const { sqrtPrice, tick: newTick } = getSqrtPriceAndTickBySquFuryPrice(newScaledSquFuryPrice, wethIsToken0)
        await squfuryEthPool.setSlot0Data(sqrtPrice, newTick)
        
        const { ethAmount, wPowerPerpAmount } = await vaultLib.getUniPositionBalances(
          uniPositionManager.address, 
          nftTokenId, 
          newTick,
          wethIsToken0
        )
        // x * y = k
        expect(isSimilar(ethAmount.mul(wPowerPerpAmount).toString(), ethLiquidityAmount.mul(wsqufuryLiquidityAmount).toString())).to.be.true
        // eth / squfury is similar to new price
        expect(isSimilar(ethAmount.mul(oracleScaleFactor).toString(), newPrice.mul(wPowerPerpAmount).toString(), 3)).to.be.true
      })
    })
    
    describe('case: LP only in a certain range', async() => {
      const nftTokenId = 1
      const initSquFuryPrice = BigNumber.from('3000').mul(one).div(oracleScaleFactor)
      let initSqrtX96Price: string
      let initTick: string

      let wsqufuryLiquidityAmount: BigNumber
      const ethLiquidityAmount = parseEther('30')

      let liquidity: BigNumber

      before('calculate shared variables', async( )=> {
        token0 = wethIsToken0 ? weth.address : squfury.address
        token1 = wethIsToken0 ? squfury.address : weth.address
      })

      before('set price parameters', async() => {
        const { sqrtPrice, tick } = getSqrtPriceAndTickBySquFuryPrice(initSquFuryPrice, wethIsToken0)
        initSqrtX96Price = sqrtPrice
        initTick = tick
      })

      before('set LP token properties, assuming with enter with init price.', async() => {
        const { sqrtPrice: sqrtPriceInit } = getSqrtPriceAndTickBySquFuryPrice(initSquFuryPrice, wethIsToken0)

        const scaledSquFuryPrice4500 = BigNumber.from('4500').mul(one).div(oracleScaleFactor)
        const scaledSquFuryPrice2000 = BigNumber.from('2000').mul(one).div(oracleScaleFactor)

        const { sqrtPrice: sqrtPrice4500, tick: tick4000 } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice4500, wethIsToken0)
        const { sqrtPrice: sqrtPrice2000, tick: tick2000 } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice2000, wethIsToken0)

        // get approximate liquidity value, with 30 eth deposit
        liquidity = wethIsToken0
          ? await vaultLib.getLiquidityForAmount0(sqrtPriceInit, sqrtPrice2000, ethLiquidityAmount.toString())
          : await vaultLib.getLiquidityForAmount1(sqrtPriceInit, sqrtPrice2000, ethLiquidityAmount.toString())

        const tickUpper = wethIsToken0 ? tick2000 : tick4000;
        const tickLower = wethIsToken0 ? tick4000 : tick2000;

        const result = await vaultLib.getAmountsForLiquidity(sqrtPriceInit, sqrtPrice2000, sqrtPrice4500, liquidity)

        // set reasonable squfury liquidity amount
        wsqufuryLiquidityAmount = wethIsToken0 
          ? result.amount1
          : result.amount0

        // set property: liquidity and ticks
        await uniPositionManager.setMockedProperties(token0, token1, tickLower, tickUpper, liquidity)
      })

      describe('case: price remains the same, we\'re in the range', async() => {
        before('set initial price', async() => {
          await squfuryEthPool.setSlot0Data(initSqrtX96Price, initTick)
        })
        it('should return approximate amount', async() => {
          const result = await vaultLib.getUniPositionBalances(
            uniPositionManager.address, 
            nftTokenId, 
            initTick,
            wethIsToken0
          )
          // about 0.01 squfury
          expect(isSimilar(result.wPowerPerpAmount.toString(), wsqufuryLiquidityAmount.toString(), 3)).to.be.true
          // about 30 eth
          expect(isSimilar(result.ethAmount.toString(), ethLiquidityAmount.toString(), 3)).to.be.true
        })
      })

      describe('case: current price is 5000, above the LP range', async() => {
        const highPrice = BigNumber.from('5000').mul(one)
        let newTick: string;
        before('set price', async() => {
          const { sqrtPrice, tick } = getSqrtPriceAndTickBySquFuryPrice(highPrice, wethIsToken0)
          newTick = tick
          await squfuryEthPool.setSlot0Data(sqrtPrice, tick)
        })
        it('should return expected amount of squfury and eth', async() => {
          const result = await vaultLib.getUniPositionBalances(
            uniPositionManager.address, 
            nftTokenId, 
            newTick,
            wethIsToken0
          )
          expect(result.wPowerPerpAmount.isZero()).to.be.true

          const upperBound = 4500 / oracleScaleFactor.toNumber()
          const lowerBound = 2000 / oracleScaleFactor.toNumber()

          const expectedEthAmount = wethIsToken0
            ? getXAmountBelowRange((1/upperBound), (1/lowerBound), liquidity.toString())
            : getYAmountAboveRange(lowerBound, upperBound, liquidity.toString())                
          
          expect(isSimilar(result.ethAmount.toString(), expectedEthAmount.toString())).to.be.true
        })
      })

      describe('case: current price 1900, below the LP range', async() => {
        const lowPrice = BigNumber.from('1900').mul(one).div(oracleScaleFactor)
        let newTick: string;
        before('set price', async() => {
          const { sqrtPrice, tick } = getSqrtPriceAndTickBySquFuryPrice(lowPrice, wethIsToken0)
          newTick = tick;
          await squfuryEthPool.setSlot0Data(sqrtPrice, tick)
        })
        it('should return expected amount of squfury and eth', async() => {
          const result = await vaultLib.getUniPositionBalances(
            uniPositionManager.address, 
            nftTokenId,
            newTick,
            wethIsToken0
          )
          expect(result.ethAmount.isZero()).to.be.true

          const upperBound = 4500 / oracleScaleFactor.toNumber()
          const lowerBound = 2000 / oracleScaleFactor.toNumber()

          const expectedSquFuryAmount = wethIsToken0
            ? getYAmountAboveRange((1/upperBound), (1/lowerBound), liquidity.toString())
            : getXAmountBelowRange(lowerBound, upperBound, liquidity.toString())
        
          expect(isSimilar(result.wPowerPerpAmount.toString(), expectedSquFuryAmount.toString())).to.be.true             

        })
      })

      describe('case: current price 2200, within LP range', async() => {
        const newPrice = BigNumber.from('2200').mul(one).div(oracleScaleFactor)
        let newTick: string
        before('set price', async() => {
          const { sqrtPrice, tick } = getSqrtPriceAndTickBySquFuryPrice(newPrice, wethIsToken0)
          newTick = tick;
          await squfuryEthPool.setSlot0Data(sqrtPrice, tick)
          
        })
        it('should return expected amount of squfury and eth', async() => {
          const result = await vaultLib.getUniPositionBalances(
            uniPositionManager.address, 
            nftTokenId, 
            newTick,
            wethIsToken0
          )

          const upperBound = 4500 / oracleScaleFactor.toNumber()
          const currentPrice = 2200 / oracleScaleFactor.toNumber()
          const lowerBound = 2000 / oracleScaleFactor.toNumber()
          
          const expectedEthAmount = wethIsToken0
            ? getXAmountBelowRange((1/currentPrice), (1/lowerBound), liquidity.toString())
            : getYAmountAboveRange(lowerBound, currentPrice, liquidity.toString())    
          
          expect(isSimilar(result.ethAmount.toString(), expectedEthAmount.toString(), 3)).to.be.true
          
          

          const expectedSquFuryAmount = wethIsToken0
            ? getYAmountAboveRange((1/upperBound), (1/currentPrice), liquidity.toString())
            : getXAmountBelowRange(currentPrice, upperBound, liquidity.toString())

          expect(isSimilar(result.wPowerPerpAmount.toString(), expectedSquFuryAmount.toString())).to.be.true
        })
      })
    })
  });
});
