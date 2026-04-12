export const miniAppHost = {
  solanaProviderRequest: undefined,
};

export const sdk = {
  wallet: {
    async getSolanaProvider() {
      return null;
    },
  },
};

const farcasterMiniAppSdkShim = {
  miniAppHost,
  sdk,
};

export default farcasterMiniAppSdkShim;
