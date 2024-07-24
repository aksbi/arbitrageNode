//const axios = require('axios');
const ethers = require('ethers');
const { Web3 } = require('web3');
const chalk = require('chalk');
//const player = require('play-sound')(opts = {});
const data = require('./data.js');
const wallets = require('./wallets.js');
const web3 = new Web3(data.config.RPC_URL);
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

async function post(url, data, ip) {
    return new Promise((resolve, reject) => {
        const curlCommand = `curl --silent --interface ${ip} -X POST -H "Content-Type: application/json" -d '${JSON.stringify(data)}' ${url}`;
        exec(curlCommand, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                try {
                    const parsedResponse = JSON.parse(stdout);
                    resolve(parsedResponse);
                } catch (parseError) {
                    resolve({
                        parseError: true,
                        raw: stdout
                    });
                }
            }
        });
    });
}

class ArbitrageBot {
    constructor() { this.resetState(); this.currentIpIndex = 0; }

    getNextIP() {
        const ip = data.IPs[this.currentIpIndex];
        this.currentIpIndex = (this.currentIpIndex + 1) % data.IPs.length;
        return ip;
    }


    resetState() {
        this.shouldStopQuotes = false; this.executingQuote = null; this.transaction = null; this.quoteCount = 0;
        this.provider = null; this.tokenInfo = {}; this.totalBalance = 0; this.activeTokens = [];
        this.quoteResult = null; this.walletAddress = null; this.privateKey = null; this.account = null;
    }

    

    getRandomPercentage() {
        const ranges = data.config.tradePercentageRanges;
        const selectedRange = ranges[Math.floor(Math.random() * ranges.length)];
        return Math.floor(Math.random() * (selectedRange.max - selectedRange.min + 1)) + selectedRange.min;
    }

    async initializeProvider(retries = 5) {
        for (let i = 0; i < retries; i++) {
            try {
                this.provider = new ethers.JsonRpcProvider(data.config.RPC_URL);
                const network = await this.provider.getNetwork();
                if (network.chainId !== BigInt(data.config.CHAIN_ID)) {
                    throw new Error(`Connected to wrong network. Expected chain ID ${data.config.CHAIN_ID}, got ${network.chainId}`);
                }
                return;
            } catch (error) {
                console.log(chalk.yellow(`Attempt ${i + 1}/${retries} failed to connect to Arbitrum RPC. Retrying in 2 seconds...`));
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        throw new Error('Failed to connect to Arbitrum RPC after multiple attempts');
    }

    async createQuoteStream() {
        const interval = 1000 / data.config.QUOTES_PER_SECOND;
        return new Promise((resolve) => {
            const intervalId = setInterval(async () => {
                if (this.shouldStopQuotes) { clearInterval(intervalId); resolve(); return; }
                await this.processQuote(++this.quoteCount);
            }, interval);
        });
    }

    async getTokenInfo(tokenAddress, walletAddress) {
        const contract = new ethers.Contract(tokenAddress, [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)"
        ], this.provider);
        const [balance, decimals] = await Promise.all([contract.balanceOf(walletAddress), contract.decimals()]);
        return { balance, decimals };
    }

    async processQuote(quoteNumber) {
        const quoteResult = await this.getODOSQuote();
        if (!this.shouldStopQuotes && quoteResult) {
            const { profitable, formattedOutput } = this.checkTradeCondition(quoteResult);
            console.log(formattedOutput);
            if (profitable) {
                this.executingQuote = quoteNumber;
                this.transaction = {
                    ...quoteResult.transaction,
                    inputTokenName: quoteResult.tokenInfo.tokenName,
                    inputTokenAddress: quoteResult.inputTokenAddress,
                    inputTokenDecimals: quoteResult.inputTokenDecimals,
                    outputTokenName: quoteResult.outputTokenName,
                    outputTokenAddress: quoteResult.outputTokenAddress,
                    outputTokenDecimals: quoteResult.outputTokenDecimals
                };
                this.quoteResult = quoteResult;
                this.shouldStopQuotes = true;
            }
        }
    }

    getPercentageForToken(tokenBalance) {
        return tokenBalance >= this.totalBalance * 0.5 ? this.getRandomPercentage() : data.config.lowBalancePercentage;
    }

    modifyData(data) {
        const originalData = data;
        data = data.slice(2);
        let pos = 8;
        let inputAmountLength = Number(BigInt(`0x${data.slice(pos * 2, (pos + 32) * 2)}`) >> BigInt(248));
        pos += 1;
        if (inputAmountLength) {
            let inputAmount = BigInt(`0x${data.slice(pos * 2, (pos + inputAmountLength) * 2)}`);
            pos += inputAmountLength;
            let outputQuoteStartPos = pos;
            let quoteAmountLength = Number(BigInt(`0x${data.slice(pos * 2, (pos + 32) * 2)}`) >> BigInt(248));
            pos += 1 + quoteAmountLength;
            let slippageTolerance = Number(BigInt(`0x${data.slice(pos * 2, (pos + 32) * 2)}`) >> BigInt(232));
            let newOutputQuote = (inputAmount * BigInt(0xFFFFFF)) / BigInt(0xFFFFFF - slippageTolerance);
            let newOutputQuoteHex = newOutputQuote.toString(16).padStart(quoteAmountLength * 2, '0');
            return '0x' + data.slice(0, outputQuoteStartPos * 2 + 2) + newOutputQuoteHex + data.slice((outputQuoteStartPos + 1 + quoteAmountLength) * 2);
        } else {
            return originalData;
        } 
    }

    getRandomTokenAndAmount() {
        const tokens = this.activeTokens;
        const useHighBalance = Math.random() < (data.config.highBalanceProbability / 100);
        const sortedTokens = tokens.sort((a, b) => this.tokenInfo[b].balance - this.tokenInfo[a].balance);
        let selectedToken = useHighBalance ? 
            sortedTokens[Math.floor(Math.random() * Math.ceil(sortedTokens.length / 2))] :
            sortedTokens[Math.floor(Math.random() * Math.floor(sortedTokens.length / 2) + Math.floor(sortedTokens.length / 2))];
        const tokenData = this.tokenInfo[selectedToken];
        const tokenAddress = data.token_address[selectedToken];
        const percentage = this.getPercentageForToken(tokenData.balance);
        const amount = (tokenData.balance * percentage / 100).toFixed(6);
        return { tokenName: selectedToken, tokenAddress, amount, totalBalance: tokenData.balance, percentage, decimals: tokenData.decimals };
    }

    getRandomOutputToken(inputTokenAddress) {
        const outputTokens = Object.entries(data.token_address).filter(([_, address]) => address !== inputTokenAddress);
        return outputTokens[Math.floor(Math.random() * outputTokens.length)];
    }

    async getODOSQuote() {
        if (this.shouldStopQuotes) return null;
        const { tokenName: inputTokenName, tokenAddress: inputTokenAddress, amount: inputAmount, totalBalance, percentage, decimals: inputDecimals } = this.getRandomTokenAndAmount();
        const [outputTokenName, outputTokenAddress] = this.getRandomOutputToken(inputTokenAddress);
        const outputDecimals = this.tokenInfo[outputTokenName]?.decimals || 18;

        const disableRFQs = Math.random() * 100 > data.config.RFQProbability;

        const quoteRequest = {
            chainId: data.config.CHAIN_ID,
            inputTokens: [{ amount: ethers.parseUnits(inputAmount, inputDecimals).toString(), tokenAddress: inputTokenAddress }],
            outputTokens: [{ proportion: 1, tokenAddress: outputTokenAddress }],
            slippageLimitPercent: 5, userAddr: this.walletAddress, referralCode: 0, disableRFQs: disableRFQs, compact: true, sourceBlacklist: ['Hashflow', 'Swaap V2']
        };
       
        try {

            
            const quoteIp = this.getNextIP();
            const quoteResponse = await post('https://api.odos.xyz/sor/quote/v2', quoteRequest, quoteIp);

            if (quoteResponse.parseError) {
                if (quoteResponse.raw.includes('CloudFront')){
                    throw new Error(`ODOS Throttling IP ${quoteIp}`);
                } else {
                    throw new Error(`ODOS Unknwn error: ${quoteResponse.raw}`);
                }
            }

            if (this.shouldStopQuotes) return null;
            const quote = quoteResponse;
            const assembleRequest = { pathId: quote.pathId, simulate: true, userAddr: this.walletAddress };
            const assembleIp = this.getNextIP();
            const assembleResponse = await post('https://api.odos.xyz/sor/assemble', assembleRequest, assembleIp);

            if (assembleResponse.parseError) {
                if (assembleResponse.raw.includes('CloudFront')){
                    throw new Error(`ODOS Throttling IP ${assembleIp}`);
                } else {
                    throw new Error(`ODOS Unknwn error: ${assembleResponse.raw}`);
                }
            }

            const transaction = assembleResponse;

            try {
                if (transaction.transaction.data) {
                    transaction.transaction.data = this.modifyData(transaction.transaction.data);
                } 
            } catch {
                throw new Error(transaction.detail.message);
            }

            let outputAmount = null;
            if (transaction.simulation.simulationError == null) {
                outputAmount = ethers.formatUnits(transaction.simulation.amountsOut[0], outputDecimals);
            } else {
                throw new Error('Simulation error: ' + transaction.simulation.simulationError.errorMessage);
            }
            
            return {
                inputAmount: parseFloat(inputAmount), outputAmount: parseFloat(outputAmount),
                transaction: transaction.transaction, tokenInfo: { tokenName: inputTokenName, percentage, totalBalance },
                outputTokenName, gasEstimate: quote.gasEstimate, gasEstimateValue: quote.gasEstimateValue,
                gweiPerGas: quote.gweiPerGas, inputTokenAddress, inputTokenDecimals: inputDecimals,
                outputTokenAddress, outputTokenDecimals: outputDecimals, disableRFQs
            };
        } catch (error) {
            if (!this.shouldStopQuotes) {
                const errorMessage = error.response ? JSON.stringify(error.response) : 
                                     error.request ? "No response received" : error.message || "Unknown error";
                console.log(chalk.red(`ODOS error: ${errorMessage}`));
                
            }
            return null;
        }
    }

    checkTradeCondition(quoteResult) {
        const profit = quoteResult.outputAmount - quoteResult.inputAmount - quoteResult.gasEstimateValue;
        const ethPrice = quoteResult.gasEstimateValue / (quoteResult.gasEstimate * quoteResult.gweiPerGas * 1e-9);
        const formattedOutput = this.formatOutput(quoteResult, quoteResult.gasEstimateValue, profit, ethPrice, this.walletAddress);
        return { profitable: profit > (1.1 * quoteResult.gasEstimateValue), formattedOutput };
        //return { profitable: profit > data.config.minProfit, formattedOutput };
        
    }

    formatOutput(quoteResult, gasFeeUsd, profit, ethPrice, walletAddress) {
        const { tokenName: inputTokenName, percentage, totalBalance } = quoteResult.tokenInfo;
        const outputTokenName = quoteResult.outputTokenName;
        const inputAmount = quoteResult.inputAmount.toFixed(6);
        const outputAmount = quoteResult.outputAmount.toFixed(6);
        const percentageStr = `${percentage.toString().padStart(3)}%`;
        const balanceStr = totalBalance.toFixed(2).padStart(8);
        const tokenPairStr = `${inputTokenName.padEnd(6)} -> ${outputTokenName.padEnd(6)}`;
        const amountStr = `${inputAmount.padStart(12)} -> ${outputAmount.padStart(12)}`;
        const feeStr = `fees: $${gasFeeUsd.toFixed(3)}`;
        const profitStr = `profit: ${profit >= 0 ? '+' : ''}${profit.toFixed(3)}`;
        const ethPriceStr = `ETH: $${ethPrice.toFixed(2)}`;
        const walletStr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        const rfqStatus = quoteResult.disableRFQs ? 'RFQ Off' : 'RFQ On ';
        const baseStr = `| ${percentageStr} of ${balanceStr}| ${tokenPairStr}: ${amountStr} | ${feeStr} | `;
        const coloredProfitStr = profit >= 0 ? chalk.green(profitStr) : chalk.red(profitStr);
        return baseStr + coloredProfitStr + ` | ${ethPriceStr} | ${walletStr} | ${rfqStatus}`;
    }

    async executeTrade(quoteNumber, tx, quoteResult) {
        this.shouldStopQuotes = true;
        this.executingQuote = quoteNumber;
        console.log(chalk.green(`Trade opportunity found at quote ${quoteNumber}!`));
        const ethPrice = quoteResult.gasEstimateValue / (quoteResult.gasEstimate * quoteResult.gweiPerGas * 1e-9);
        try {
            const receipt = await web3.eth.sendTransaction(tx);
            //player.play('/System/Library/Sounds/Glass.aiff', (err) => {
            //    if (err) console.log(`Could not play sound: ${err}`);
            //});
            const transactionFeeEth = web3.utils.fromWei(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), 'ether');
            const realInputAmount = ethers.formatUnits(BigInt(receipt.logs[0].data), tx.inputTokenDecimals);
            const realOutputAmount = ethers.formatUnits(BigInt(receipt.logs[receipt.logs.length - 2].data), tx.outputTokenDecimals);
            console.log(chalk.green(`Transaction executed!`));
            console.log(chalk.green(`Hash: ${receipt.transactionHash}`));
            console.log(chalk.green(`${realInputAmount} ${tx.inputTokenName} -> ${realOutputAmount} ${tx.outputTokenName}`));
            console.log(chalk.yellow(`Transaction fee: $${(transactionFeeEth*ethPrice).toFixed(3)}`));
            const realProfit = realOutputAmount - realInputAmount - (transactionFeeEth * ethPrice);
            const profitColor = realProfit >= 0 ? chalk.green : chalk.red;
            console.log(profitColor(`Real transaction profit: ${realProfit >= 0 ? '+' : ''}${realProfit.toFixed(3)}`));
            await this.updateTokenInfo();
        } catch (error) {
            console.log(chalk.red(`Transaction error: ${error.message}`));
            throw error;
        }
    }

    async updateTokenInfo() {
        const tokenInfoPromises = Object.entries(data.token_address).map(async ([tokenName, tokenAddress]) => {
            try {
                const { balance, decimals } = await this.getTokenInfo(tokenAddress, this.walletAddress);
                return { tokenName, balance: parseFloat(ethers.formatUnits(balance, decimals)), decimals };
            } catch (error) {
                console.log(chalk.red(`Error fetching info for ${tokenName}: ${error.message}`));
                return { tokenName, balance: 0, decimals: 18 };
            }
        });
        const tokenInfoArray = await Promise.all(tokenInfoPromises);
        this.tokenInfo = Object.fromEntries(tokenInfoArray.map(({ tokenName, balance, decimals }) => [tokenName, { balance, decimals }]));
        this.totalBalance = tokenInfoArray.reduce((sum, { balance }) => sum + balance, 0);
        this.activeTokens = tokenInfoArray.filter(({ balance }) => balance > 0).map(({ tokenName }) => tokenName);
        console.log(chalk.cyan(`Balances: ${tokenInfoArray.map(({ tokenName, balance }) => `${tokenName}: ${balance}`).join(', ')} (Total: ${this.totalBalance.toFixed(2)}) | Wallet: ${this.walletAddress}`));
    }

    async initializeWallet() {
        this.walletAddress = Object.keys(wallets.address)[0];
        this.privateKey = wallets.address[this.walletAddress];
        this.account = web3.eth.accounts.privateKeyToAccount(this.privateKey);
        web3.eth.accounts.wallet.add(this.account);
    }

    async run() {
        let isFirstRun = true;
        while (true) {
            try {
                if (isFirstRun) {
                    await this.initializeProvider();
                    await this.initializeWallet();
                    await this.updateTokenInfo();
                    isFirstRun = false;
                }
                this.shouldStopQuotes = false; this.executingQuote = null; this.transaction = null;
                this.quoteCount = 0; this.quoteResult = null;  
                if (this.activeTokens.length === 0) {
                    console.log(chalk.yellow('No active tokens found. Waiting for 5 seconds before checking again...'));
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                await this.createQuoteStream();
                if (this.executingQuote) {
                    await this.executeTrade(this.executingQuote, this.transaction, this.quoteResult);
                } else {
                    console.log(chalk.yellow('No profitable trade found in this cycle. Continuing to search...'));
                }
            } catch (error) {
                console.log(chalk.red(`An error occurred: ${error.message}`));
                console.log(chalk.yellow('Restarting bot now...'));
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }
}

const bot = new ArbitrageBot();
bot.run();
