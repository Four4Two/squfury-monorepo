import { ethers } from "hardhat"
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { constants } from "ethers";
import { WPowerPerp } from "../../typechain";

describe("WPowerPerp", function () {
  let wsqufury: WPowerPerp;
  let address1: SignerWithAddress
  let controller: SignerWithAddress
  let random: SignerWithAddress

  this.beforeAll("Prepare accounts", async() => {
    const accounts = await ethers.getSigners();
    const [_address1, _controller, _random] = accounts;
    address1 = _address1
    controller = _controller
    random = _random
  });
  
  describe("Deploymenl", async() => {
    it("Deployment", async function () {
      const WPowerPerpContract = await ethers.getContractFactory("WPowerPerp");
      wsqufury = (await WPowerPerpContract.deploy('Wrapped SquFury', 'WSQU')) as WPowerPerp;
    });
  })

  describe("Initialization", async () => {
    it("should revert when calling init with invalid address as controller", async () => {
      await expect(wsqufury.init(constants.AddressZero)).to.be.revertedWith('Invalid controller address')
    })
    it("should revert when calling init from a random address", async () => {
      await expect(wsqufury.connect(random).init(controller.address)).to.be.revertedWith('Invalid caller of init')
    })
    it("should init with controller address when called by the deployer", async () => {
      await wsqufury.connect(address1).init(controller.address)
      expect(await wsqufury.controller()).to.be.eq(controller.address)
    })
    it('should revert when trying to init again', async() => {
      await expect(wsqufury.init(controller.address)).to.be.revertedWith('Initializable: contract is already initialized')
    })
    it("should have decimals 18", async () => {
      expect(await wsqufury.decimals()).to.be.eq(18)
    })
  })
  describe("Minting and burning", async () => {
    it("should mint with controller", async () => {
    const mintAmount = 10
      await wsqufury.connect(controller).mint(random.address, mintAmount)
      expect((await wsqufury.balanceOf(random.address)).eq(mintAmount)).to.be.true
    })
    it("should revert when minted from non-controller", async () => {
      const mintAmount = 10
      await expect(wsqufury.connect(random).mint(random.address, mintAmount)).to.be.revertedWith('Not controller');
    })
    it("should revert when burned from non-controller", async () => {
        const burnAmount = 10
        await expect(wsqufury.connect(random).burn(random.address, burnAmount)).to.be.revertedWith('Not controller');
    })
      
    it("should burn from controler", async () => {
      const burnAmount = 10
      await wsqufury.connect(controller).burn(random.address, burnAmount);
      expect((await wsqufury.balanceOf(random.address)).eq(0)).to.be.true
    })
  }) 
})
