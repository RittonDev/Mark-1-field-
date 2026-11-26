// Stub da sonda da sessão: o SecureStore na memória. `store` tem as chaves gravadas e `writes`, a ordem das gravações.
export const store = new Map();
export const writes = [];

export const secureStorage = {
  async getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    writes.push(key);
    store.set(key, value);
  },
  async removeItem(key) {
    store.delete(key);
  },
};
