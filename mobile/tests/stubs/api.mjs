// Stub da sonda da sessão: GET /me/profile devolve o cadastro que o teste pôs em `server.profile` (como o servidor).
export const server = { profile: null };

export const api = {
  async get(path) {
    if (path === "/me/profile") return structuredClone(server.profile);
    throw new Error(`stub: GET ${path}`);
  },
  async post(path) {
    throw new Error(`stub: POST ${path}`);
  },
  async patch(path) {
    throw new Error(`stub: PATCH ${path}`);
  },
  async delete(path) {
    throw new Error(`stub: DELETE ${path}`);
  },
};

export async function uploadFile() {
  throw new Error("stub: upload");
}
