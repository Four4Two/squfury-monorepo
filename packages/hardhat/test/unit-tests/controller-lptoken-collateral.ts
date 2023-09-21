import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { ethers } from "hardhat"
import { expect } from "chai";
import { BigNumber } from "ethers";
import { parseEther } from "ethers/lib/utils";
import { Controller, MockWPowerPerp, MockShortPowerPerp, MockOracle, MockUniswapV3Pool, MockErc20, MockUniPositionManager, VaultLibTester, IWETH9, LiquidationHelper, ABDKMath64x64 } from "../../typechain";
import { getSqrtPriceAndTickBySquFuryPrice } from "../calculator";
import { oracleScaleFactor, one } from "../utils";

// use the same price at first, so there's no funding.
const squfuryETHPrice = BigNumber.from('3000').mul(one)
const scaledSquFuryPrice = squfuryETHPrice.div(oracleScaleFactor)


// eth dai price
const ethDaiPrice = BigNumber.from('3000').mul(one)


describe("Controller: Uni LP tokens collateralization", function () {
  let squfury: MockWPowerPerp;
  let shortSquFury: MockShortPowerPerp;
  let controller: Controller;
  let squfuryEthPool: MockUniswapV3Pool;
  let ethDaiPool: MockUniswapV3Pool;
  let uniPositionManager: MockUniPositionManager
  let oracle: MockOracle;
  let weth: IWETH9;
  let dai: MockErc20;
  let vaultLib: VaultLibTester
  let liquidationHelper: LiquidationHelper
  let seller1: SignerWithAddress
  let random: SignerWithAddress
  let liquidator: SignerWithAddress

  let daiIsToken0InEthPool: boolean
  let wethIsToken0InSquFuryPool: boolean

  const provider = ethers.provider

  this.beforeAll("Prepare accounts", async() => {
    const accounts = await ethers.getSigners();
    const [,_seller1, _random, _liquidator] = accounts;
    seller1 = _seller1
    random = _random
    liquidator = _liquidator
  })

  this.beforeAll("Setup environment", async () => {
    const MockSQUContract = await ethers.getContractFactory("MockWPowerPerp");
    squfury = (await MockSQUContract.deploy()) as MockWPowerPerp;

    const NFTContract = await ethers.getContractFactory("MockShortPowerPerp");
    shortSquFury = (await NFTContract.deploy()) as MockShortPowerPerp;

    const OracleContract = await ethers.getContractFactory("MockOracle");
    oracle = (await OracleContract.deploy()) as MockOracle;

    const MockErc20Contract = await ethers.getContractFactory("MockErc20");
    dai = (await MockErc20Contract.deploy("Dai", "Dai", 18)) as MockErc20;

    const WETH9Contract = await ethers.getContractFactory("WETH9");
    weth = (await WETH9Contract.deploy()) as IWETH9;

    const MockUniswapV3PoolContract = await ethers.getContractFactory("MockUniswapV3Pool");
    squfuryEthPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;
    ethDaiPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;

    const MockPositionManager = await ethers.getContractFactory("MockUniPositionManager");
    uniPositionManager = (await MockPositionManager.deploy()) as MockUniPositionManager;

    // mint weth and squfury to position manager
    await weth.connect(random).deposit({value: parseEther('500')})
    await weth.connect(random).transfer(uniPositionManager.address, parseEther('500'))
    await squfury.connect(random).mint(uniPositionManager.address, parseEther('500'))

    const SqrtPriceExternal = await ethers.getContractFactory("SqrtPriceMathPartial")
    const SqrtPriceExternalLibrary = (await SqrtPriceExternal.deploy());

    const TickMathExternal = await ethers.getContractFactory("TickMathExternal")
    const TickMathLibrary = (await TickMathExternal.deploy());

    const VaultTester = await ethers.getContractFactory("VaultLibTester", {libraries: {TickMathExternal: TickMathLibrary.address, SqrtPriceMathPartial: SqrtPriceExternalLibrary.address}});
    vaultLib = (await VaultTester.deploy()) as VaultLibTester;

    // set token0 and token1 for squfury/eth pool
    wethIsToken0InSquFuryPool = parseInt(weth.address, 16) < parseInt(squfury.address, 16)
    if (wethIsToken0InSquFuryPool) {
      await squfuryEthPool.setPoolTokens(weth.address, squfury.address);
    } else {
      await squfuryEthPool.setPoolTokens(squfury.address, weth.address);
    }

    daiIsToken0InEthPool = parseInt(dai.address, 16) < parseInt(weth.address, 16)
    if (daiIsToken0InEthPool)  {
      await ethDaiPool.setPoolTokens(dai.address, weth.address);
    } else {
      await ethDaiPool.setPoolTokens(weth.address, dai.address);
    }
    await oracle.connect(random).setPrice(squfuryEthPool.address, scaledSquFuryPrice)

    await oracle.connect(random).setPrice(ethDaiPool.address, ethDaiPrice)

    const { tick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)
    await oracle.setAverageTick(squfuryEthPool.address, tick)
  });

  this.beforeAll("Deploy Controller", async () => {
    const ABDK = await ethers.getContractFactory("ABDKMath64x64")
    const ABDKLibrary = (await ABDK.deploy()) as ABDKMath64x64;
  
    const TickMath = await ethers.getContractFactory("TickMathExternal")
    const TickMathLibrary = (await TickMath.deploy());

    const SqrtPriceExternal = await ethers.getContractFactory("SqrtPriceMathPartial")
    const SqrtPriceExternalLibrary = (await SqrtPriceExternal.deploy());

    const ControllerContract = await ethers.getContractFactory("Controller", {libraries: {ABDKMath64x64: ABDKLibrary.address, TickMathExternal: TickMathLibrary.address, SqrtPriceMathPartial: SqrtPriceExternalLibrary.address}});
    controller = (await ControllerContract.deploy(oracle.address, shortSquFury.address, squfury.address, weth.address, dai.address, ethDaiPool.address, squfuryEthPool.address, uniPositionManager.address, 3000)) as Controller;

    const LiqHelperFactory = await ethers.getContractFactory("LiquidationHelper", {libraries: {TickMathExternal: TickMathLibrary.address, SqrtPriceMathPartial: SqrtPriceExternalLibrary.address}});
    liquidationHelper = await LiqHelperFactory.deploy(
        controller.address,
        oracle.address,
        squfury.address,
        weth.address,
        dai.address,
        ethDaiPool.address,
        squfuryEthPool.address,
        uniPositionManager.address
      ) as LiquidationHelper;
  })

  describe("Vault1 and Vault2: Basic Flow", function () {

    let vaultId: BigNumber;
    const uniNFTId = 1;
    const mintAmount = ethers.utils.parseUnits('100')
    const collateralAmount = ethers.utils.parseUnits('45')

    let token0: string
    let token1: string
    
      before("Open vault and mint perfect amount of squfury", async () => {
        vaultId = await shortSquFury.nextId()
        await controller.connect(seller1).mintPowerPerpAmount(0, mintAmount, 0, {value: collateralAmount})
        // mint uni nft for users
        await uniPositionManager.mint(seller1.address, uniNFTId)
        
        // mint 2nd nft for user to test reverting
        const nextUniNFTId = 2
        await controller.connect(seller1).mintPowerPerpAmount(0, mintAmount, 0, {value: collateralAmount})
        // mint uni nft for users
        await uniPositionManager.mint(seller1.address, nextUniNFTId)
      });

      before('Prepare shared variables', async() => {
        token0 = wethIsToken0InSquFuryPool ? weth.address : squfury.address
        token1 = wethIsToken0InSquFuryPool ? squfury.address : weth.address
      })

      it('should revert when trying to deposit a LP token to vault 0', async() => {
        await expect(controller.connect(seller1).depositUniPositionToken(0, 0)).to.be.revertedWith(
          'ERC721: owner query for nonexistent token'
        )
      })

      it('should revert when trying to deposit a LP token to non-existent vault', async() => {
        await expect(controller.connect(seller1).depositUniPositionToken(100, 0)).to.be.revertedWith(
          'ERC721: owner query for nonexistent token'
        )
      })

      it('should revert when trying to deposit a LP token from a different pool', async ()=> {
        // set token0 and token to dai and squfury
        await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)
        await uniPositionManager.setMockedProperties(dai.address, squfury.address, 0, 0, 1)

        await expect(controller.connect(seller1).depositUniPositionToken(vaultId, uniNFTId)).to.be.revertedWith('C23')
      })

      it('should revert when trying to deposit a LP token with id 0', async ()=> {
        await uniPositionManager.mint(seller1.address, 0)

        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220
        const { sqrtPrice: sqrtX96Price, tick: currentTick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('100')

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)

        await uniPositionManager.connect(seller1).approve(controller.address, 0)
        await expect(controller.connect(seller1).depositUniPositionToken(vaultId, 0)).to.be.revertedWith('C23')
      })

      it('should revert when depositor do not own the NFT', async ()=> {
        const tokenId = 77;
        await uniPositionManager.mint(random.address, tokenId)

        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220
        const { sqrtPrice: sqrtX96Price, tick: currentTick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('100')

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)

        await expect(controller.connect(seller1).depositUniPositionToken(vaultId, tokenId)).to.be.revertedWith('ERC721: transfer caller is not owner nor approved')
      })

      it('should revert when a random address tries to add a NFT to a vault they are not owner or operator of', async ()=> {
        const tokenId = 77;
        await expect(controller.connect(random).depositUniPositionToken(vaultId, tokenId)).to.be.revertedWith('C20')
      })

      it('should revert when trying to deposit a 0 liquidity NFT', async ()=> {
        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220
        const { sqrtPrice: sqrtX96Price, tick: currentTick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('0')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('0')

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)

        // // deposit NFT
        await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)

        await expect(controller.connect(seller1).depositUniPositionToken(vaultId, uniNFTId)).to.be.revertedWith("C25")
      
      })


      it('should deposit and NFT to an existing vault.', async() => {
        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220
        const { sqrtPrice: sqrtX96Price, tick: currentTick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('100')

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)

        // // deposit NFT
        await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)
        const ownerBefore = await uniPositionManager.ownerOf(uniNFTId);

        await controller.connect(seller1).depositUniPositionToken(vaultId, uniNFTId)
        
        const ownerAfter = await uniPositionManager.ownerOf(uniNFTId);  
        expect(ownerBefore === seller1.address).to.be.true
        expect(ownerAfter === controller.address).to.be.true      
      })

      it('should revert if a user tries to deposit a second nft.', async() => {
        
        const newUniNFTId = 2
        
        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220
        const { sqrtPrice: sqrtX96Price, tick: currentTick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('100')

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)

        // // deposit NFT
        await uniPositionManager.connect(seller1).approve(controller.address, newUniNFTId)

        await expect(controller.connect(seller1).depositUniPositionToken(vaultId, newUniNFTId)).to.be.revertedWith("V1")        
      })

      it('should revert if vault id is 0', async() => {
        await expect(controller.connect(seller1).withdrawUniPositionToken(0)).to.be.revertedWith(
          'ERC721: owner query for nonexistent token'
        )
      })

      it('should revert if vault id is too high', async() => {
        await expect(controller.connect(seller1).withdrawUniPositionToken(100)).to.be.revertedWith(
          'ERC721: owner query for nonexistent token'
        )
      })

      it('should revert if non owner withdraws the nft', async () => {
        await expect(controller.connect(random).withdrawUniPositionToken(vaultId)).to.be.revertedWith("C20")
      })

      it('should withdraw the nft successfully', async () => {
        const ownerBefore = await uniPositionManager.ownerOf(uniNFTId);

        await controller.connect(seller1).withdrawUniPositionToken(vaultId)

        const ownerAfter = await uniPositionManager.ownerOf(uniNFTId);        
        expect(ownerBefore === controller.address).to.be.true
        expect(ownerAfter === seller1.address).to.be.true
      })

      it('should revert when trying to withdraw from a empty vault', async () => {
        await expect(controller.connect(seller1).withdrawUniPositionToken(vaultId)).to.be.revertedWith('V2')
      })

      it('should deposit an NFT to an existing vault using _openDepositMint', async() => {

        // // deposit NFT
        await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)
        const ownerBefore = await uniPositionManager.ownerOf(uniNFTId);

        await controller.connect(seller1).mintPowerPerpAmount(0, mintAmount, uniNFTId)
        
        const ownerAfter = await uniPositionManager.ownerOf(uniNFTId);  
        expect(ownerBefore === seller1.address).to.be.true
        expect(ownerAfter === controller.address).to.be.true      
      })

  })

  describe('Vault3: Basic Collateralization checks', async() => {
    let vaultId: BigNumber;
    const uniNFTId = 3;
    const mintAmount = ethers.utils.parseUnits('100')
    const collateralAmount = ethers.utils.parseUnits('45')

    let token0: string
    let token1: string

    describe('Case: price is at the same', async () => {
      let currentTick: string;
      before("open vault and mint perfect amount of squfury", async () => {
        vaultId = await shortSquFury.nextId()
        await controller.connect(seller1).mintPowerPerpAmount(0, mintAmount,0, {value: collateralAmount})
        await uniPositionManager.mint(seller1.address, uniNFTId)
      });
  
      before('prepare shared variables', async() => {
        token0 = wethIsToken0InSquFuryPool ? weth.address : squfury.address
        token1 = wethIsToken0InSquFuryPool ? squfury.address : weth.address
      })
  
      before('deposit NFT into the vault', async() => {
        await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)
        await controller.connect(seller1).depositUniPositionToken(vaultId, uniNFTId)
      })

      before('set LP token properties', async() => {
        
        const { sqrtPrice: sqrtX96Price, tick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)
        currentTick = tick

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('100')

        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)
      })

      it('should be able to mint more squfury after lp deposit', async() => {

        const { ethAmount, wPowerPerpAmount } = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, currentTick, wethIsToken0InSquFuryPool)
        const equivalentCollateral = ethAmount.add(wPowerPerpAmount.mul(ethDaiPrice))
        const vaultBefore = await controller.vaults(vaultId)
        
        const squfuryToMint = equivalentCollateral.div(ethDaiPrice).mul(2).div(3)
        
        await controller.connect(seller1).mintPowerPerpAmount(vaultId, squfuryToMint, 0)
        const vaultAfter = await controller.vaults(vaultId)
        
        // burn the minted amount 
        const wSquFuryMinted = vaultAfter.shortAmount.sub(vaultBefore.shortAmount)
        await controller.connect(seller1).burnWPowerPerpAmount(vaultId, wSquFuryMinted, 0)
      })
  
      it('should be able to remove all collateral after lp token deposit, because the lp token is worth 2x the debt amount.', async() => {
        await controller.connect(seller1).withdraw(vaultId, collateralAmount)
        const vaultAfter = await controller.vaults(vaultId)
        expect(vaultAfter.NftCollateralId === uniNFTId).to.be.true
        expect(vaultAfter.collateralAmount.isZero()).to.be.true
      })
  
      it('should revert if trying to remove LP token from the vault.', async() => {
        await expect(controller.connect(seller1).withdrawUniPositionToken(vaultId)).to.be.revertedWith('C24')
      })

      it('update nft property to stimulate losses in Uni LP', async() => {
        const { sqrtPrice: sqrtX96Price } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)
        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('0.3')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('1')
        const nftTickUpper = 887220
        const nftTickLower = -887220
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)
      })

      it('should revert when effective collateral after withdraw < dust limit', async() => {
        it('should revert if trying to remove LP token from the vault.', async() => {
          const vault = await controller.vaults(vaultId)
          await expect(controller.connect(seller1).withdraw(vaultId, vault.collateralAmount)).to.be.revertedWith('C22')
        })
      })

      // only got NFT left in the vault
    })
    describe('Case: price increase, vault should go underwater', async() => {
      let newTick: string;
      let newSquFuryPrice: BigNumber
      before("assume we start LPing when price was 3000. with range 2000 - 4000", async () => {
        // the let's assume price range is only 2000 -> 4000, so if squfury price > 4000
        // we will only have eth left in LP token.
        // old price was 3000
        
        const { sqrtPrice: oldSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)

        // fix deposit eth amount at 30

        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const scaledPrice4000 = BigNumber.from('4000').mul(one).div(oracleScaleFactor)
        const scaledPrice2000 = BigNumber.from('2000').mul(one).div(oracleScaleFactor)

        const { tick: tick4000 } = getSqrtPriceAndTickBySquFuryPrice(scaledPrice4000, wethIsToken0InSquFuryPool)
        const { sqrtPrice: sqrtPrice2000, tick: tick2000 } = getSqrtPriceAndTickBySquFuryPrice(scaledPrice2000, wethIsToken0InSquFuryPool)

        // get approximate liquidity value, with 30 eth deposit
        const liquidity = wethIsToken0InSquFuryPool
          ? await vaultLib.getLiquidityForAmount0(oldSqrtPrice, sqrtPrice2000, ethLiquidityAmount.toString())
          : await vaultLib.getLiquidityForAmount1(oldSqrtPrice, sqrtPrice2000, ethLiquidityAmount.toString())
        
        const tickUpper = wethIsToken0InSquFuryPool ? tick2000 : tick4000;
        const tickLower = wethIsToken0InSquFuryPool ? tick4000 : tick2000;

        await uniPositionManager.setMockedProperties(token0, token1, tickLower, tickUpper, liquidity) // use the same liquidity
      })
      before('set price to 4500', async() => {
        const ethPrice = BigNumber.from('4500').mul(one)
        newSquFuryPrice = ethPrice.div(oracleScaleFactor)
        const { tick, sqrtPrice: newSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(newSquFuryPrice, wethIsToken0InSquFuryPool)
        // update prices in pool and oracle.
        newTick = tick
        await squfuryEthPool.setSlot0Data(newSqrtPrice, newTick)
        await oracle.setPrice(squfuryEthPool.address, newSquFuryPrice)
        await oracle.setAverageTick(squfuryEthPool.address, newTick)

        
        await oracle.setPrice(ethDaiPool.address, ethPrice)
      })
      it('should become underwater if squfury price increase, and LP token has no enough eth to cover short position.', async () => {
        const result = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)
        // LP token worth 0 squfury
        expect(result.wPowerPerpAmount.isZero()).to.be.true
        // not enough eth value in LP token!
        const requiredCollateral = mintAmount.mul(newSquFuryPrice).mul(3).div(2)
        expect(result.ethAmount.lt(requiredCollateral)).to.be.true
        
        await expect(controller.connect(seller1).withdraw(vaultId, 0)).to.be.revertedWith('C24')
      })
      it('should be able to liquidate the NFT', async() => {
        const vaultBefore = await controller.vaults(vaultId)
        const { ethAmount, wPowerPerpAmount } = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)
        
        // mint squfury for liquidator
        const liquidationAmount = vaultBefore.shortAmount.sub(wPowerPerpAmount).div(2)
        const ethCollateral = liquidationAmount.mul(newSquFuryPrice).div(one).mul(2) // with 2 collateral ratio
        await controller.connect(liquidator).mintPowerPerpAmount(0, liquidationAmount, 0, {value: ethCollateral})

        expect(vaultBefore.NftCollateralId === 0).to.be.false

        const token0ToSet = wethIsToken0InSquFuryPool ? ethAmount : wPowerPerpAmount
        const token1ToSet = wethIsToken0InSquFuryPool ? wPowerPerpAmount : ethAmount
        await uniPositionManager.setAmount0Amount1ToDecrease(token0ToSet, token1ToSet)

        const balanceBefore = await provider.getBalance(liquidator.address)

        // liquidate the vault
        const tx = await controller.connect(liquidator).liquidate(vaultId, liquidationAmount)
        const vaultAfter = await controller.vaults(vaultId)
        const balanceAfter = await provider.getBalance(liquidator.address)
        
        const reward = liquidationAmount.mul(newSquFuryPrice).div(one).mul(11).div(10)
        
        // expect(balanceAfter.sub(balanceBefore).eq(reward)).to.be.true
        expect(vaultAfter.NftCollateralId === 0).to.be.true // nft is liquidated
        expect(vaultAfter.shortAmount.eq(vaultBefore.shortAmount.sub(liquidationAmount))).to.be.true
        expect(vaultAfter.collateralAmount.eq(vaultBefore.collateralAmount.add(ethAmount).sub(reward))).to.be.true
      })
    })
    describe('Case: price decrease, vault should above water', async() => {
      let newTick:string
      before('set price to 1500', async() => {
        const ethPrice = BigNumber.from('1500').mul(one)
        const newScaledSquFuryPrice = ethPrice.div(oracleScaleFactor)
        const { tick, sqrtPrice: newSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(newScaledSquFuryPrice, wethIsToken0InSquFuryPool)
        newTick = tick 
        // update prices in pool and oracle.
        await squfuryEthPool.setSlot0Data(newSqrtPrice, newTick)
        await oracle.setPrice(squfuryEthPool.address , newScaledSquFuryPrice)
        await oracle.setAverageTick(squfuryEthPool.address, newTick)

        await oracle.setPrice(ethDaiPool.address , ethPrice)
      })
      it('should be able to collateralize the vault', async () => {

        const result = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)

        const token0ToSet = wethIsToken0InSquFuryPool ? result.ethAmount : result.wPowerPerpAmount
        const token1ToSet = wethIsToken0InSquFuryPool ? result.wPowerPerpAmount : result.ethAmount
        await uniPositionManager.setAmount0Amount1ToDecrease(token0ToSet, token1ToSet)

        // LP token worth 0 eth
        expect(result.ethAmount.isZero()).to.be.true
        expect(result.wPowerPerpAmount.gt(mintAmount)).to.be.true
        
        const vaultBefore = await controller.vaults(vaultId)
        await controller.connect(seller1).mintPowerPerpAmount(vaultId, 10, 0)
        const vaultAfter = await controller.vaults(vaultId)
        expect(vaultAfter.shortAmount.gt(vaultBefore.shortAmount)).to.be.true
      })
      it('should revert when trying to liquidate the NFT', async() => {
        const liquidationAmount = ethers.utils.parseUnits('50')
        await expect(controller.connect(liquidator).liquidate(vaultId, liquidationAmount)).to.be.revertedWith(
          'C12'
        )
      })
    })
  });

  describe('Vault4: Saving vault by burning NFT', async() => {
    // We use the exact setup as Vault2:
    // open vault => mint squfury => add uni NFT => withdraw all collateral from the vault
    // so the price scenario should be identical, we're just testing saving vaults here.
    let vaultId: BigNumber;
    const uniNFTId = 4;
    const mintAmount = ethers.utils.parseUnits('100')
    const collateralAmount = ethers.utils.parseUnits('45')

    let token0: string
    let token1: string
    
    describe('Case: price is at the same', async () => {

      let currentTick: string;

      before('set price back to 3000', async() => {
        const { tick, sqrtPrice: newSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice.toString(), wethIsToken0InSquFuryPool)
        const newTick = tick 
        // update prices in pool and oracle.
        await squfuryEthPool.setSlot0Data(newSqrtPrice, newTick)
        await oracle.setPrice(squfuryEthPool.address , scaledSquFuryPrice)

        await oracle.setPrice(ethDaiPool.address , ethDaiPrice)
        await oracle.setAverageTick(squfuryEthPool.address, newTick)
      })
      
      before("open vault and mint perfect amount of squfury", async () => {
        vaultId = await shortSquFury.nextId()
        await controller.connect(seller1).mintPowerPerpAmount(0, mintAmount,0, {value: collateralAmount})
        await uniPositionManager.mint(seller1.address, uniNFTId)
      });
  
      before('prepare shared variables', async() => {
        token0 = wethIsToken0InSquFuryPool ? weth.address : squfury.address
        token1 = wethIsToken0InSquFuryPool ? squfury.address : weth.address
      })
  
      before('deposit NFT into the vault', async() => {
        await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)
        await controller.connect(seller1).depositUniPositionToken(vaultId, uniNFTId)
      })

      before('set LP token properties', async() => {
        const { sqrtPrice: sqrtX96Price, tick } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)
        currentTick = tick

        // how much to stimulate as LP deposit
        const ethLiquidityAmount = ethers.utils.parseUnits('30')
        const squfuryLiquidityAmount = ethers.utils.parseUnits('100')

        // infinite price range
        const nftTickUpper = 887220
        const nftTickLower = -887220

        // nft ticks
        const liquidity = await vaultLib.getLiquidity(
          sqrtX96Price,
          nftTickLower,
          nftTickUpper,
          wethIsToken0InSquFuryPool ? ethLiquidityAmount : squfuryLiquidityAmount,
          wethIsToken0InSquFuryPool ? squfuryLiquidityAmount: ethLiquidityAmount,
        )
        
        await squfuryEthPool.setSlot0Data(sqrtX96Price, currentTick)
        await uniPositionManager.setMockedProperties(token0, token1, nftTickLower, nftTickUpper, liquidity)
      })

      it('should be able to remove all collateral after lp token deposit, because the lp token is worth 2x the debt amount.', async() => {
        await controller.connect(seller1).withdraw(vaultId, collateralAmount)
        const vaultAfter = await controller.vaults(vaultId)
        expect(vaultAfter.NftCollateralId === uniNFTId).to.be.true
        expect(vaultAfter.collateralAmount.isZero()).to.be.true
        // only got NFT left in the vault
      })
  
      it('should revert when calling from random address', async() => {
        await expect(controller.connect(random).reduceDebt(vaultId)).to.be.revertedWith('C20')
      })
    })
    describe('Case: price increase, vault should go underwater and people can save it', async() => {
      let newTick: string;
      let newSquFuryPrice: BigNumber
      before("assume we start LPing when price was 3000. with range 2000 - 4000", async () => {
        // the let's assume price range is only 2000 -> 4000, so if squfury price > 4000
        // we will only have eth left in LP token.
        // old price was 3000
        const { sqrtPrice: oldSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice, wethIsToken0InSquFuryPool)
        
        const scaledPrice4000 = BigNumber.from('4000').mul(one).div(oracleScaleFactor).toString()
        const scaledPrice2000 = BigNumber.from('2000').mul(one).div(oracleScaleFactor).toString()

        // fix deposit eth amount at 30
        const ethLiquidityAmount = ethers.utils.parseUnits('30')

        const { tick: tick4000 } = getSqrtPriceAndTickBySquFuryPrice(scaledPrice4000, wethIsToken0InSquFuryPool)
        const { sqrtPrice: sqrtPrice2000, tick: tick2000 } = getSqrtPriceAndTickBySquFuryPrice(scaledPrice2000, wethIsToken0InSquFuryPool)

        // get approximate liquidity value, with 30 eth deposit
        const liquidity = wethIsToken0InSquFuryPool
          ? await vaultLib.getLiquidityForAmount0(oldSqrtPrice, sqrtPrice2000, ethLiquidityAmount.toString())
          : await vaultLib.getLiquidityForAmount1(oldSqrtPrice, sqrtPrice2000, ethLiquidityAmount.toString())
        
        const tickUpper = wethIsToken0InSquFuryPool ? tick2000 : tick4000;
        const tickLower = wethIsToken0InSquFuryPool ? tick4000 : tick2000;

        await uniPositionManager.setMockedProperties(token0, token1, tickLower, tickUpper, liquidity) // use the same liquidity
      })
      before('set price to 5000', async() => {
        newSquFuryPrice = BigNumber.from('5000').mul(one)     
        const newScaledSquFuryPrice = newSquFuryPrice.div(oracleScaleFactor)

        const { tick, sqrtPrice: newSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(newScaledSquFuryPrice, wethIsToken0InSquFuryPool)
        // update prices in pool and oracle.
        newTick = tick
        await squfuryEthPool.setSlot0Data(newSqrtPrice, newTick)
        await oracle.setPrice(squfuryEthPool.address, newScaledSquFuryPrice.mul(one))
        await oracle.setAverageTick(squfuryEthPool.address, newTick)

        // set eth dai pool price to 5000
        await oracle.setPrice(ethDaiPool.address, newSquFuryPrice)
      })
      it('should become underwater if squfury price increase, and LP token has no enough eth', async () => {
        const result = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)
        // LP token worth 0 squfury
        expect(result.wPowerPerpAmount.isZero()).to.be.true
        // not enough eth value in LP token!
        const requiredCollateral = mintAmount.mul(newSquFuryPrice).mul(3).div(2)
        expect(result.ethAmount.lt(requiredCollateral)).to.be.true
        
        await expect(controller.connect(seller1).withdraw(vaultId, 0)).to.be.revertedWith('C24')
      })
      before('set NFT redemption amount', async () => {
        const { ethAmount, wPowerPerpAmount } = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)
        const token0ToSet = wethIsToken0InSquFuryPool ? ethAmount : wPowerPerpAmount
        const token1ToSet = wethIsToken0InSquFuryPool ? wPowerPerpAmount : ethAmount
        await uniPositionManager.setAmount0Amount1ToDecrease(token0ToSet, token1ToSet)
      })
      it('should be able to reduce the debt by calling liquidate', async() => {
        const vaultBefore = await controller.vaults(vaultId)
        const { ethAmount, wPowerPerpAmount } = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)
        // save the vault
        await controller.connect(seller1).liquidate(vaultId, 0)
        
        const vaultAfter = await controller.vaults(vaultId)
        expect(vaultAfter.NftCollateralId === 0).to.be.true // nft is redeemed
        expect(vaultAfter.shortAmount.eq(vaultBefore.shortAmount.sub(wPowerPerpAmount))).to.be.true
        expect(vaultAfter.collateralAmount.eq(vaultBefore.collateralAmount.add(ethAmount))).to.be.true
      })
    })
    
    describe('Case: the nft worth more wsqufury than minted', async() => {
      /**
       * Scenario: the vault is safe when price is 4500
       * Deposit NFT: range order
       * 
       */
      const oldEthPrice = BigNumber.from('5000').mul(one).div(oracleScaleFactor)
      let newTick: string
      const newNFTId = 5

      before('set LP token properties: range order [10000 - 15000]', async() => {
        const vault = await controller.vaults(vaultId)

        // assume there's a NFT has wSquFuryAmount value of 110% * shortAmount
        const wsqufuryLiquidityAmount = vault.shortAmount.mul(11).div(10);

        const scaledSquFuryPrice10000 = BigNumber.from('10000').mul(one).div(oracleScaleFactor)
        const scaledSquFuryPrice15000 = BigNumber.from('15000').mul(one).div(oracleScaleFactor)

        const { sqrtPrice: sqrtPrice10000, tick: tick10000 } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice10000, wethIsToken0InSquFuryPool)
        const { sqrtPrice: sqrtPrice1500, tick: tick15000 } = getSqrtPriceAndTickBySquFuryPrice(scaledSquFuryPrice15000, wethIsToken0InSquFuryPool)

        // get approximate liquidity value, with fixed wsqufury amount
        const liquidity = wethIsToken0InSquFuryPool
          ? await vaultLib.getLiquidityForAmount1(sqrtPrice1500, sqrtPrice10000, wsqufuryLiquidityAmount.toString())
          : await vaultLib.getLiquidityForAmount0(sqrtPrice1500, sqrtPrice10000, wsqufuryLiquidityAmount.toString())
        
        const tickUpper = wethIsToken0InSquFuryPool ? tick10000 : tick15000;
        const tickLower = wethIsToken0InSquFuryPool ? tick15000 : tick10000;

        await uniPositionManager.setMockedProperties(token0, token1, tickLower, tickUpper, liquidity) // use the same liquidity
      })

      before('deposit NFT into the vault, withdraw some collateral', async() => {
        await uniPositionManager.mint(seller1.address, newNFTId)
        await uniPositionManager.connect(seller1).approve(controller.address, newNFTId)
        await controller.connect(seller1).depositUniPositionToken(vaultId, newNFTId)

        const vault = await controller.vaults(vaultId)
        const totalCollateralRequired = vault.shortAmount.mul(oldEthPrice).div(one).mul(3).div(2)

        // nft is equivalent as 110% short amount * index
        const nftEquivalentEthValue = vault.shortAmount.mul(11).div(10).mul(oldEthPrice).div(one)

        const minEthRequired = totalCollateralRequired.sub(nftEquivalentEthValue)
        const maxWithdrawableEth = vault.collateralAmount.sub(minEthRequired)

        await controller.connect(seller1).withdraw(vaultId, maxWithdrawableEth)
      })

      before('set price to 8000', async() => {
        const newSquFuryPrice = BigNumber.from('8000').mul(one)
        
        const scaledNewSquFuryPrice = newSquFuryPrice.div(oracleScaleFactor)
        const { tick, sqrtPrice: newSqrtPrice } = getSqrtPriceAndTickBySquFuryPrice(scaledNewSquFuryPrice, wethIsToken0InSquFuryPool)
        // update prices in pool and oracle.
        newTick = tick
        await squfuryEthPool.setSlot0Data(newSqrtPrice, newTick)
        await oracle.setPrice(squfuryEthPool.address, scaledNewSquFuryPrice)
        await oracle.setAverageTick(squfuryEthPool.address, newTick)

        // set eth price to 8000
        await oracle.setPrice(ethDaiPool.address, newSquFuryPrice)
      })

      before('set NFT redemption amount', async () => {
        const { ethAmount, wPowerPerpAmount } = await vaultLib.getUniPositionBalances(uniPositionManager.address, uniNFTId, newTick, wethIsToken0InSquFuryPool)
        const token0ToSet = wethIsToken0InSquFuryPool ? ethAmount : wPowerPerpAmount
        const token1ToSet = wethIsToken0InSquFuryPool ? wPowerPerpAmount : ethAmount
        await uniPositionManager.setAmount0Amount1ToDecrease(token0ToSet, token1ToSet)
      })

      it('anyone can safe the vault, the owner will receive extra wsqufury withdrawn from Uniswap', async() => {
        // the vault should be underwater now
        
        await expect(controller.connect(seller1).mintPowerPerpAmount(vaultId, 1, 0)).to.be.revertedWith('C24')
        const vaultBefore = await controller.vaults(vaultId)
        const { wPowerPerpAmount: nftSquFuryAmount } = await vaultLib.getUniPositionBalances(uniPositionManager.address, newNFTId, newTick, wethIsToken0InSquFuryPool)

        const ownerWSquFuryBefore = await squfury.balanceOf(seller1.address)

        const result = await liquidationHelper.checkLiquidation(vaultId);
        const isUnsafe = result[0]
        const isLiquidatableAfterReducingDebt = result[1]
        const maxWPowerPerpAmount = result[2]  

        await controller.connect(seller1).reduceDebt(vaultId)
        const vaultAfter = await controller.vaults(vaultId)

        const ownerWSquFuryAfter = await squfury.balanceOf(seller1.address)

        const wsqufuryExcess = nftSquFuryAmount.sub(vaultBefore.shortAmount)

        expect(isUnsafe).to.be.true
        expect(isLiquidatableAfterReducingDebt).to.be.false
        expect(maxWPowerPerpAmount.eq(BigNumber.from(0))).to.be.true

        expect(ownerWSquFuryAfter.sub(ownerWSquFuryBefore).eq(wsqufuryExcess)).to.be.true
        expect(vaultAfter.NftCollateralId === 0).to.be.true
        expect(vaultAfter.shortAmount.isZero()).to.be.true
      })
      it('calling reduceDebt will not take effect if the vault has not nft', async() => {
        
        const vaultBefore = await controller.vaults(vaultId)
        await controller.connect(seller1).reduceDebt(vaultId)
        const vaultAfter = await controller.vaults(vaultId)

        expect(vaultAfter.collateralAmount.eq(vaultBefore.collateralAmount)).to.be.true
        expect(vaultAfter.shortAmount.eq(vaultBefore.shortAmount)).to.be.true
      })
    })
  });

  describe('Vault5: test combined actions', async() => {
    let vaultId: BigNumber;
    const uniNFTId = 99;

    const testDepositAmount = ethers.utils.parseUnits('10')

    before('prepare vault and nft for user', async() => {
      vaultId = await shortSquFury.nextId()
      await controller.connect(seller1).mintPowerPerpAmount(0, 0, 0, {value: testDepositAmount})

      await uniPositionManager.mint(seller1.address, uniNFTId)
      await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)
    })

    it('should just deposit lp token and mint if deposit amount is 0', async() => {
      const testMintWAmount = ethers.utils.parseUnits('0.001')
      const vaultBefore = await controller.vaults(vaultId)
      await controller.connect(seller1).mintWPowerPerpAmount(vaultId, testMintWAmount, uniNFTId)
      const vaultAfter = await controller.vaults(vaultId)

      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).isZero()).to.be.true
      expect(vaultAfter.shortAmount.sub(vaultBefore.shortAmount).eq(testMintWAmount)).to.be.true
      expect(vaultAfter.NftCollateralId === uniNFTId).to.be.true

      // withdraw nft
      await controller.connect(seller1).withdrawUniPositionToken(vaultId)
    })

    it('should just deposit lp token and deposit eth if mint amount is 0', async() => {
      const vaultBefore = await controller.vaults(vaultId)
      await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)        
      await controller.connect(seller1).mintWPowerPerpAmount(vaultId, 0, uniNFTId, {value: testDepositAmount})
      const vaultAfter = await controller.vaults(vaultId)

      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).eq(testDepositAmount)).to.be.true
      expect(vaultAfter.shortAmount.sub(vaultBefore.shortAmount).isZero()).to.be.true
      expect(vaultAfter.NftCollateralId === uniNFTId).to.be.true

      await controller.connect(seller1).withdrawUniPositionToken(vaultId)
    })
    it('should do nothing but deposit uni nft if both deposit and mint amount are 0', async() => {
      const vaultBefore = await controller.vaults(vaultId)
      await uniPositionManager.connect(seller1).approve(controller.address, uniNFTId)     
      await controller.connect(seller1).mintWPowerPerpAmount(vaultId, 0, uniNFTId)
      const vaultAfter = await controller.vaults(vaultId)

      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).isZero()).to.be.true
      expect(vaultAfter.shortAmount.sub(vaultBefore.shortAmount).isZero()).to.be.true
      expect(vaultAfter.NftCollateralId === uniNFTId).to.be.true

      await controller.connect(seller1).withdrawUniPositionToken(vaultId)
    })
  })
});
