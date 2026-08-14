/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as googleHealth_crypto from "../googleHealth/crypto.js";
import type * as googleHealth_model from "../googleHealth/model.js";
import type * as googleHealth_normalize from "../googleHealth/normalize.js";
import type * as googleHealth_registry from "../googleHealth/registry.js";
import type * as googleHealth_validators from "../googleHealth/validators.js";
import type * as helpers from "../helpers.js";
import type * as sleep from "../sleep.js";
import type * as workouts from "../workouts.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "googleHealth/crypto": typeof googleHealth_crypto;
  "googleHealth/model": typeof googleHealth_model;
  "googleHealth/normalize": typeof googleHealth_normalize;
  "googleHealth/registry": typeof googleHealth_registry;
  "googleHealth/validators": typeof googleHealth_validators;
  helpers: typeof helpers;
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
