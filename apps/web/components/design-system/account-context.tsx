"use client";

import { createContext, useContext } from "react";
import type { HeaderAccount } from "../../lib/auth/header-account.ts";

const AccountContext = createContext<HeaderAccount | null>(null);

export function AccountProvider({ account, children }: { account: HeaderAccount | null; children: React.ReactNode }) {
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

export function useHeaderAccount(): HeaderAccount | null {
  return useContext(AccountContext);
}
