import { actionTree, getterTree, mutationTree } from "typed-vuex";
import { ChangePubkeyTypes } from "zksync/build/types";
import { ChangePubKeyFee } from "zksync/src/types";

import { ETHOperation } from "@/plugins/types";
import { walletData } from "@/plugins/walletData";

let updateBalancesTimeout = undefined as any;

interface depositsInterface {
  [tokenSymbol: string]: Array<{
    hash: string;
    amount: string;
    status: string;
    confirmations: number;
  }>;
}

export const state = () => ({
  watchedTransactions: {} as {
    [txHash: string]: {
      [prop: string]: string;
      status: string;
    };
  },
  deposits: {} as depositsInterface,
  forceUpdateTick: 0,
  withdrawalTxToEthTx: new Map() as Map<string, string>,
});

export type TransactionModuleState = ReturnType<typeof state>;

export const mutations = mutationTree(state, {
  updateTransactionStatus(state, { hash, status }): void {
    if (status === "Verified") {
      delete state.watchedTransactions[hash];
      return;
    }
    if (!state.watchedTransactions.hasOwnProperty(hash)) {
      state.watchedTransactions[hash] = {
        status,
      };
    } else {
      state.watchedTransactions[hash].status = status;
    }
  },
  updateDepositStatus(state, { tokenSymbol, hash, amount, status, confirmations }) {
    if (!Array.isArray(state.deposits[tokenSymbol])) {
      state.deposits[tokenSymbol] = [];
    }
    let txIndex = -1;
    for (let a = 0; a < state.deposits[tokenSymbol].length; a++) {
      if (state.deposits[tokenSymbol][a].hash === hash) {
        txIndex = a;
        break;
      }
    }
    if (txIndex === -1) {
      state.deposits[tokenSymbol].push({
        hash,
        amount,
        status,
        confirmations,
      });
      state.forceUpdateTick++;
    } else {
      state.deposits[tokenSymbol][txIndex].status = status;
      state.forceUpdateTick++;
    }
  },
  setWithdrawalTx(state, { tx, ethTx }) {
    state.withdrawalTxToEthTx.set(tx, ethTx);
  },
});

export const getters = getterTree(state, {
  depositList(state) {
    return state.deposits;
  },
  getWithdrawalTx(state) {
    return (tx: string): string | undefined => {
      return state.withdrawalTxToEthTx.get(tx);
    };
  },
});

export const actions = actionTree(
  { state, getters, mutations },
  {
    async watchTransaction({ dispatch, commit, state }, { transactionHash, existingTransaction /* , tokenSymbol, type */ }): Promise<void> {
      try {
        if (state.watchedTransactions.hasOwnProperty(transactionHash)) {
          return;
        }
        if (!existingTransaction) {
          await walletData.get().syncProvider!.notifyTransaction(transactionHash, "COMMIT");
          commit("updateTransactionStatus", { hash: transactionHash, status: "Committed" });
          dispatch("requestBalancesUpdate");
        } else {
          commit("updateTransactionStatus", { hash: transactionHash, status: "Committed" });
        }
        await walletData.get().syncProvider!.notifyTransaction(transactionHash, "VERIFY");
        commit("updateTransactionStatus", { hash: transactionHash, status: "Verified" });
        dispatch("requestBalancesUpdate");
      } catch (error) {
        commit("updateTransactionStatus", { hash: transactionHash, status: "Verified" });
      }
    },
    async watchDeposit({ dispatch, commit }, { depositTx, tokenSymbol, amount }: { depositTx: ETHOperation; tokenSymbol: string; amount: string }): Promise<void> {
      try {
        commit("updateDepositStatus", { hash: depositTx!.ethTx.hash, tokenSymbol, amount, status: "Initiated", confirmations: 1 });
        await depositTx.awaitEthereumTxCommit();
        dispatch("requestBalancesUpdate");
        await depositTx.awaitReceipt();
        dispatch("requestBalancesUpdate");
        commit("updateDepositStatus", { hash: depositTx!.ethTx.hash, tokenSymbol, status: "Committed" });
        await depositTx.awaitVerifyReceipt();
        dispatch("requestBalancesUpdate");
        commit("updateDepositStatus", { hash: depositTx!.ethTx.hash, tokenSymbol, status: "Verified" });
      } catch (error) {
        commit("updateDepositStatus", { hash: depositTx!.ethTx.hash, tokenSymbol, status: "Verified" });
      }
    },
    requestBalancesUpdate(): void {
      clearTimeout(updateBalancesTimeout);
      updateBalancesTimeout = setTimeout(() => {
        this.dispatch("wallet/requestZkBalances", { accountState: undefined, force: true });
        this.dispatch("wallet/requestTransactionsHistory", { offset: 0, force: true });
      }, 2000);
    },

    /**
     * Receive correct Fee amount
     * @param {any} address
     * @param {any} feeToken
     * @return {Promise<any>}
     */
    fetchChangePubKeyFee: async function ({}, { address, feeToken }) {
      const syncWallet = walletData.get().syncWallet;
      const syncProvider = walletData.get().syncProvider;
      if (syncWallet?.ethSignerType?.verificationMethod === "ERC-1271") {
        const isOnchainAuthSigningKeySet = await syncWallet!.isOnchainAuthSigningKeySet();
        if (!isOnchainAuthSigningKeySet) {
          const onchainAuthTransaction = await syncWallet!.onchainAuthSigningKey();
          await onchainAuthTransaction?.wait();
        }
      }
      const ethAuthType = syncWallet?.ethSignerType?.verificationMethod === "ERC-1271" ? "Onchain" : "ECDSA";
      //@ts-ignore
      return syncProvider?.getTransactionFee({ ChangePubKey: ethAuthType as ChangePubkeyTypes } as ChangePubKeyFee, address, feeToken);
    },
  },
);
