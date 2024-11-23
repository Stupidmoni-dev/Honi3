require('dotenv').config();
const { createLogger, format, transports } = require('winston');
const Bottleneck = require('bottleneck');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const { Telegraf } = require('telegraf');

// Configuration
const config = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    SOLSCAN_API_KEY: process.env.SOLSCAN_API_KEY || '',
    SOLSCAN_API_URL: 'https://api.solscan.io',
    COINGECKO_API_URL: 'https://api.coingecko.com/api/v3',
};

// Logger setup
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'bot.log' }),
    ],
});

// Rate limiter
const limiter = new Bottleneck({
    minTime: 300,
    maxConcurrent: 5,
});

// Solana API setup
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');

// Fetching token info (from Solscan)
async function getTokenInfoFromSolscan(tokenAddress) {
    try {
        const response = await axios.get(`${config.SOLSCAN_API_URL}/api/v1/tokenInfo/${tokenAddress}`, {
            headers: { 'Authorization': `Bearer ${config.SOLSCAN_API_KEY}` }
        });
        return response.data.data;
    } catch (error) {
        logger.error(`Error fetching token info from Solscan: ${error.message}`);
        throw new Error('Failed to fetch token info.');
    }
}

// Fetching token balance
async function getTokenBalance(address, tokenAddress) {
    try {
        const publicKey = new PublicKey(address);
        const tokenAccount = await connection.getTokenAccountsByOwner(publicKey, { mint: new PublicKey(tokenAddress) });
        return tokenAccount.value[0]?.account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch (error) {
        logger.error(`Error fetching token balance: ${error.message}`);
        throw new Error('Failed to fetch token balance.');
    }
}

// Get crypto prices from CoinGecko
async function getCryptoPrices() {
    try {
        const response = await axios.get(`${config.COINGECKO_API_URL}/coins/markets`, {
            params: {
                vs_currency: 'usd',
                ids: 'solana,bitcoin,ethereum',
            },
        });
        const prices = {};
        response.data.forEach(coin => {
            prices[coin.id] = coin.current_price;
        });
        return prices;
    } catch (error) {
        logger.error(`Error fetching crypto prices: ${error.message}`);
        throw new Error('Failed to fetch crypto prices.');
    }
}

// Get gas fee (Solana)
async function getSolanaGasFee() {
    try {
        const blockhash = await connection.getRecentBlockhash();
        const fee = blockhash.feeCalculator.lamportsPerSignature;
        return fee / 1000000000;  // Convert to SOL
    } catch (error) {
        logger.error(`Error fetching gas fee: ${error.message}`);
        throw new Error('Failed to get Solana gas fee.');
    }
}

// Token analysis command
async function analyzeToken(address, tokenAddress) {
    try {
        const tokenInfo = await getTokenInfoFromSolscan(tokenAddress);
        const balance = await getTokenBalance(address, tokenAddress);
        const prices = await getCryptoPrices();
        const gasFee = await getSolanaGasFee();

        return {
            tokenInfo,
            balance,
            prices,
            gasFee,
        };
    } catch (error) {
        logger.error(`Error during analysis: ${error.message}`);
        throw new Error('Failed to analyze token.');
    }
}

// Telegram bot setup
const bot = new Telegraf(config.BOT_TOKEN);

// Command to check token info
bot.command('check', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
        return ctx.reply('❌ Usage: /check <TOKEN_ADDRESS> <SOLANA_ADDRESS>');
    }

    const [tokenAddress, address] = args;
    try {
        ctx.reply('🔍 Analyzing the token. Please wait...');
        const analysis = await analyzeToken(address, tokenAddress);
        
        ctx.reply(`
            🧾 **Token Analysis:**
            - **Token Name**: ${analysis.tokenInfo.name}
            - **Token Symbol**: ${analysis.tokenInfo.symbol}
            - **Token Price**: $${analysis.prices.solana}
            - **Your Balance**: ${analysis.balance} ${analysis.tokenInfo.symbol}
            - **Gas Fee**: ${analysis.gasFee} SOL
        `);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Command to get the balance of a Solana address
bot.command('balance', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
        return ctx.reply('❌ Usage: /balance <SOLANA_ADDRESS>');
    }

    const address = args[0];
    try {
        const balance = await connection.getBalance(new PublicKey(address));
        ctx.reply(`📊 **Solana Balance**: ${balance / 1000000000} SOL`);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Command to get current crypto prices
bot.command('prices', async (ctx) => {
    try {
        const prices = await getCryptoPrices();
        ctx.reply(`
            💰 **Current Crypto Prices**:
            - Solana: $${prices.solana}
            - Bitcoin: $${prices.bitcoin}
            - Ethereum: $${prices.ethereum}
        `);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Command to get Solana gas fee
bot.command('gas', async (ctx) => {
    try {
        const gasFee = await getSolanaGasFee();
        ctx.reply(`⛽ **Solana Gas Fee**: ${gasFee} SOL per transaction`);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Help command
bot.command('help', (ctx) => {
    ctx.reply(`
        🚀 **Solana Honeypot Checker Bot - Commands**:

        /check <TOKEN_ADDRESS> <SOLANA_ADDRESS> - Analyze token info
        /balance <SOLANA_ADDRESS> - Get Solana balance
        /prices - Get current prices of Solana, Bitcoin, and Ethereum
        /gas - Get Solana gas fees
        /help - Display this help message
    `);
});

// Start the bot
bot.launch().then(() => logger.info('Bot is running')).catch((error) => logger.error('Bot launch failed: ' + error.message));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
