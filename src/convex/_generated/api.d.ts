/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as googleHealth_apiClient from "../googleHealth/apiClient.js";
import type * as googleHealth_account from "../googleHealth/account.js";
import type * as googleHealth_accountNode from "../googleHealth/accountNode.js";
import type * as googleHealth_crypto from "../googleHealth/crypto.js";
import type * as googleHealth_maintenance from "../googleHealth/maintenance.js";
import type * as googleHealth_model from "../googleHealth/model.js";
import type * as googleHealth_normalize from "../googleHealth/normalize.js";
import type * as googleHealth_oauth from "../googleHealth/oauth.js";
import type * as googleHealth_records from "../googleHealth/records.js";
import type * as googleHealth_registry from "../googleHealth/registry.js";
import type * as googleHealth_sync from "../googleHealth/sync.js";
import type * as googleHealth_validators from "../googleHealth/validators.js";
import type * as googleHealth_webhook from "../googleHealth/webhook.js";
import type * as googleHealth_webhookSignature from "../googleHealth/webhookSignature.js";
import type * as helpers from "../helpers.js";
import type * as http from "../http.js";
import type * as sleep from "../sleep.js";
import type * as workouts from "../workouts.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "googleHealth/apiClient": typeof googleHealth_apiClient;
  "googleHealth/account": typeof googleHealth_account;
  "googleHealth/accountNode": typeof googleHealth_accountNode;
  "googleHealth/crypto": typeof googleHealth_crypto;
  "googleHealth/maintenance": typeof googleHealth_maintenance;
  "googleHealth/model": typeof googleHealth_model;
  "googleHealth/normalize": typeof googleHealth_normalize;
  "googleHealth/oauth": typeof googleHealth_oauth;
  "googleHealth/records": typeof googleHealth_records;
  "googleHealth/registry": typeof googleHealth_registry;
  "googleHealth/sync": typeof googleHealth_sync;
  "googleHealth/validators": typeof googleHealth_validators;
  "googleHealth/webhook": typeof googleHealth_webhook;
  "googleHealth/webhookSignature": typeof googleHealth_webhookSignature;
  helpers: typeof helpers;
  http: typeof http;
  sleep: typeof sleep;
  workouts: typeof workouts;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
