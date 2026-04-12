export function ConnectionProvider({ children }) {
  return children ?? null;
}

export function WalletProvider({ children }) {
  return children ?? null;
}

const solanaWalletAdapterReactShim = {
  ConnectionProvider,
  WalletProvider,
};

export default solanaWalletAdapterReactShim;
