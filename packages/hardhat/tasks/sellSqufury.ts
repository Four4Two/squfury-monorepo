import { task, types } from "hardhat/config";
import "@nomiclabs/hardhat-waffle";
import { BigNumber } from "ethers";
import { getUniswapDeployments, getUSDC, getWETH } from "./utils";

// Example execution
/**
 npx hardhat sellSquFury --input '1000' --network ropsten
 */
task("sellSquFury", "Sell Weth from the pool")
  .addParam('input', 'amount squfury sending', '1', types.string)
  .setAction(async ({ input: inputAmount }, hre) => {
    const { getNamedAccounts, ethers, network } = hre;
    const { deployer } = await getNamedAccounts();

    const { swapRouter } = await getUniswapDeployments(ethers, deployer, network.name);

    const weth = await getWETH(ethers, deployer, network.name)
    const squfury = await ethers.getContract("WPowerPerp", deployer);

    const oSqfuDecimal = 18
    const oSqfuAmount = BigNumber.from(inputAmount).mul(BigNumber.from(10).pow(oSqfuDecimal))

    const sqfuBalance = await squfury.balanceOf(deployer)

    // if (wethBalance.lt(wethAmount)) {
    //   console.log(`Minting new USDC`)
    //   const tx = await usdc.mint(deployer, usdcAmount)
    //   await ethers.provider.waitForTransaction(tx.hash, 1)
    // }

    const sqfuAllowance = await squfury.allowance(deployer, squfury.address)
    if (sqfuAllowance.lt(oSqfuAmount)) {
      console.log('Approving sqfu')
      const tx = await squfury.approve(swapRouter.address, ethers.constants.MaxUint256)
      tx.wait()
    }

    const exactInputParam = {
      tokenIn: squfury.address, // address
      tokenOut: weth.address, // address
      fee: 3000, // uint24
      recipient: deployer, // address
      deadline: Math.floor(Date.now() / 1000 + 86400), // uint256
      amountIn: oSqfuAmount, // uint256
      amountOutMinimum: 0, // uint256 // no slippage control now
      sqrtPriceLimitX96: 0, // uint160
    }

    const tx = await swapRouter.exactInputSingle(exactInputParam)
    tx.wait()
    console.log(`Sold oSqfu to Uni Pool successfully`)

  });
