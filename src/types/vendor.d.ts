/**
 * 少数没有自带类型声明的依赖，在这里补最小可用的声明。
 * 只声明我们真正用到的成员，避免变成"维护一份别人的 .d.ts"。
 */

declare module 'sm-crypto' {
  interface Sm2 {
    doEncrypt(msg: string | number[], publicKey: string, cipherMode?: 0 | 1): string;
    doDecrypt(
      encryptData: string,
      privateKey: string,
      cipherMode?: 0 | 1,
      options?: { output?: 'string' | 'array' },
    ): string | number[];
    getPublicKeyFromPrivateKey(privateKey: string): string;
  }
  const smCrypto: { sm2: Sm2 };
  export default smCrypto;
}
