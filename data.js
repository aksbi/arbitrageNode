const IPs = [
    'IP1',
    'IP2',
    'IP3'
  ]

const config = {
    QUOTES_PER_SECOND: 13.5, 
    minProfit: 0.03,
    RFQProbability: 100,
    highBalanceProbability: 90,
    lowBalancePercentage: 100,
    tradePercentageRanges: [
        { min: 1, max: 25 },
        { min: 26, max: 50 },
        { min: 51, max: 75 },
        { min: 76, max: 100 },
    ],
    CHAIN_ID: 42161,
    RPC_URL: "https://arb1.arbitrum.io/rpc"
    
    
};

const token_address = {
    'USDC': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'
};



module.exports = {
    config,
    token_address,
    IPs
  };
