function randomSubmissionKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inventoryMutationOptions(submissionRef, url, payload, { method = "POST", headers = {} } = {}) {
  const body = JSON.stringify(payload);
  const identity = `${url}\n${body}`;
  if (submissionRef.current?.identity !== identity) {
    submissionRef.current = { identity, key: randomSubmissionKey() };
  }

  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      "Idempotency-Key": submissionRef.current.key,
    },
    body,
  };
}

export function completeInventoryMutation(submissionRef) {
  submissionRef.current = null;
}
