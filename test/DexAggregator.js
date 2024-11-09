const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("DexAggregator", function () {
    async function deployDexAggregatorFixture() {
        const [owner, user1, user2] = await ethers.getSigners();

        // Deploy tokens
        const Token = await ethers.getContractFactory("Token");
        const tokenA = await Token.deploy("TokenA", "TA");
        const tokenB = await Token.deploy("TokenB", "TB");

        // Deploy AMMs
        const AMM = await ethers.getContractFactory("AMM");
        const AMM2 = await ethers.getContractFactory("AMM2");
        const amm1 = await AMM.deploy(tokenA.address, tokenB.address);
        const amm2 = await AMM2.deploy(tokenA.address, tokenB.address);

        // Deploy Aggregator
        const DexAggregator = await ethers.getContractFactory("DexAggregator");
        const aggregator = await DexAggregator.deploy(amm1.address, amm2.address);

        // Setup initial liquidity
        const mintAmount = ethers.utils.parseEther("1000000");
        const initLiquidityAmount = ethers.utils.parseEther("1000");

        // Mint tokens to owner
        await tokenA.mint(owner.address, mintAmount);
        await tokenB.mint(owner.address, mintAmount);

        // Add liquidity to both AMMs
        await tokenA.approve(amm1.address, initLiquidityAmount);
        await tokenB.approve(amm1.address, initLiquidityAmount);
        await amm1.addLiquidity(initLiquidityAmount, initLiquidityAmount);

        await tokenA.approve(amm2.address, initLiquidityAmount);
        await tokenB.approve(amm2.address, initLiquidityAmount);
        await amm2.addLiquidity(initLiquidityAmount, initLiquidityAmount);

        return {
            aggregator,
            amm1,
            amm2,
            tokenA,
            tokenB,
            owner,
            user1,
            user2,
            initLiquidityAmount
        };
    }

    describe("Deployment", function () {
        it("Should set the correct AMM addresses", async function () {
            const { aggregator, amm1, amm2 } = await loadFixture(deployDexAggregatorFixture);
            expect(await aggregator.amm1()).to.equal(amm1.address);
            expect(await aggregator.amm2()).to.equal(amm2.address);
        });

        it("Should show correct initial reserves", async function () {
            const { aggregator, initLiquidityAmount } = await loadFixture(deployDexAggregatorFixture);
            const reserves = await aggregator.getReserves();
            expect(reserves.amm1ReserveA).to.equal(initLiquidityAmount);
            expect(reserves.amm1ReserveB).to.equal(initLiquidityAmount);
            expect(reserves.amm2ReserveA).to.equal(initLiquidityAmount);
            expect(reserves.amm2ReserveB).to.equal(initLiquidityAmount);
        });
    });

    describe("Quote Comparison", function () {
        it("Should get quotes from both AMMs", async function () {
            const { aggregator, user1 } = await loadFixture(deployDexAggregatorFixture);
            const swapAmount = ethers.utils.parseEther("1");
            
            const [bestAMM, bestOutput] = await aggregator.getBestQuote(swapAmount, true);
            expect(bestOutput).to.be.gt(0);
        });

        it("Should return better quote from AMM1 (lower fees)", async function () {
            const { aggregator, amm1, amm2 } = await loadFixture(deployDexAggregatorFixture);
            const swapAmount = ethers.utils.parseEther("1");
            
            const [bestAMM, bestOutput] = await aggregator.getBestQuote(swapAmount, true);
            expect(bestAMM).to.equal(amm1.address); // AMM1 has 0.3% fee vs AMM2's 0.5%
        });
    });

    describe("Swap Execution", function () {
        it("Should execute swap on AMM with better quote", async function () {
            const { aggregator, tokenA, tokenB, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            // Give user1 some tokens to swap
            const swapAmount = ethers.utils.parseEther("10");
            await tokenA.transfer(user1.address, swapAmount);
            
            // Get initial balances
            const initialTokenABalance = await tokenA.balanceOf(user1.address);
            const initialTokenBBalance = await tokenB.balanceOf(user1.address);
            
            // Approve aggregator to spend tokens
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            
            // Execute swap
            const minOutput = ethers.utils.parseEther("9"); // Expecting at least 9 tokens due to fees
            await aggregator.connect(user1).executeSwap(swapAmount, true, minOutput);
            
            // Check balances after swap
            const finalTokenABalance = await tokenA.balanceOf(user1.address);
            const finalTokenBBalance = await tokenB.balanceOf(user1.address);
            
            expect(finalTokenABalance).to.be.lt(initialTokenABalance);
            expect(finalTokenBBalance).to.be.gt(initialTokenBBalance);
        });

        it("Should fail when output is less than minOutput", async function () {
            const { aggregator, tokenA, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("10");
            await tokenA.transfer(user1.address, swapAmount);
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            
            // Set unrealistically high minOutput
            const unrealisticMinOutput = ethers.utils.parseEther("11");
            
            await expect(
                aggregator.connect(user1).executeSwap(swapAmount, true, unrealisticMinOutput)
            ).to.be.revertedWith("Insufficient output amount");
        });

        it("Should fail when user has insufficient balance", async function () {
            const { aggregator, tokenA, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("10");
            // Don't transfer any tokens to user1
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            
            await expect(
                aggregator.connect(user1).executeSwap(swapAmount, true, 0)
            ).to.be.reverted;
        });

        it("Should fail when not approved", async function () {
            const { aggregator, tokenA, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("10");
            await tokenA.transfer(user1.address, swapAmount);
            // Don't approve the aggregator
            
            await expect(
                aggregator.connect(user1).executeSwap(swapAmount, true, 0)
            ).to.be.reverted;
        });
    });

    describe("Quote Events", function () {
        it("Should emit BestQuoteFound event with correct values", async function () {
            const { aggregator, amm1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("1");
            
            await expect(aggregator.checkAndEmitQuote(swapAmount, true))
                .to.emit(aggregator, "BestQuoteFound")
                .withArgs(amm1.address, await aggregator.getBestQuote(swapAmount, true).then(r => r.bestOutput));
        });

        it("Should emit SwapExecuted event after successful swap", async function () {
            const { aggregator, tokenA, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("1");
            await tokenA.transfer(user1.address, swapAmount);
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            
            await expect(aggregator.connect(user1).executeSwap(swapAmount, true, 0))
                .to.emit(aggregator, "SwapExecuted");
        });
    });

    describe("Advanced Scenarios", function () {
        it("Should handle different reserve ratios correctly", async function () {
            const { aggregator, amm1, amm2, tokenA, tokenB, owner } = await loadFixture(deployDexAggregatorFixture);
            
            // Add more liquidity to AMM1 to create different ratios
            const additionalLiquidity = ethers.utils.parseEther("1000");
            await tokenA.approve(amm1.address, additionalLiquidity);
            await tokenB.approve(amm1.address, additionalLiquidity);
            await amm1.addLiquidity(additionalLiquidity, additionalLiquidity);

            const swapAmount = ethers.utils.parseEther("1");
            const [bestAMM, bestOutput] = await aggregator.getBestQuote(swapAmount, true);

            // AMM1 should still be better due to both higher liquidity and lower fees
            expect(bestAMM).to.equal(amm1.address);
        });

        it("Should find best AMM when prices differ significantly", async function () {
            const { aggregator, amm1, amm2, tokenA, tokenB, owner, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            // Create price disparity by making several swaps on AMM2
            const swapAmount = ethers.utils.parseEther("100");
            await tokenA.approve(amm2.address, swapAmount);
            await amm2.swap(swapAmount, true); // This will impact AMM2's prices

            // Now check which AMM offers better price for a small swap
            const testAmount = ethers.utils.parseEther("1");
            const [bestAMM, bestOutput] = await aggregator.getBestQuote(testAmount, true);

            // AMM1 should offer better price as it hasn't been impacted by large swaps
            expect(bestAMM).to.equal(amm1.address);
        });

        it("Should handle consecutive swaps maintaining best price selection", async function () {
            const { aggregator, tokenA, tokenB, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("10");
            await tokenA.transfer(user1.address, swapAmount.mul(3)); // Fund for multiple swaps
            await tokenA.connect(user1).approve(aggregator.address, swapAmount.mul(3));

            // Execute three consecutive swaps
            for(let i = 0; i < 3; i++) {
                const [bestAMMBefore] = await aggregator.getBestQuote(swapAmount, true);
                await aggregator.connect(user1).executeSwap(swapAmount, true, 0);
                const [bestAMMAfter] = await aggregator.getBestQuote(swapAmount, true);

                // Best AMM might change after swaps due to changing reserves
                console.log(`Swap ${i + 1} - Best AMM before: ${bestAMMBefore}, after: ${bestAMMAfter}`);
            }
        });

        it("Should handle token approval resets correctly", async function () {
            const { aggregator, tokenA, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("10");
            await tokenA.transfer(user1.address, swapAmount);
            
            // Approve, then reset approval to 0, then approve again
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            await tokenA.connect(user1).approve(aggregator.address, 0);
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            
            // Should still execute successfully
            await expect(
                aggregator.connect(user1).executeSwap(swapAmount, true, 0)
            ).to.not.be.reverted;
        });

        it("Should verify reserves match after swaps", async function () {
            const { aggregator, tokenA, tokenB, user1 } = await loadFixture(deployDexAggregatorFixture);
            
            const swapAmount = ethers.utils.parseEther("10");
            await tokenA.transfer(user1.address, swapAmount);
            await tokenA.connect(user1).approve(aggregator.address, swapAmount);
            
            // Get reserves before
            const reservesBefore = await aggregator.getReserves();
            
            // Execute swap
            await aggregator.connect(user1).executeSwap(swapAmount, true, 0);
            
            // Get reserves after
            const reservesAfter = await aggregator.getReserves();
            
            // Verify reserves changed appropriately
            expect(reservesAfter.amm1ReserveA.add(reservesAfter.amm2ReserveA))
                .to.be.gt(reservesBefore.amm1ReserveA.add(reservesBefore.amm2ReserveA));
        });
    });
});
