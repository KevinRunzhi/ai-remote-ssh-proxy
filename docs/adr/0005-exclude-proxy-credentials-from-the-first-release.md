# Exclude proxy credentials from the first release

The first release accepts only unauthenticated `http://` Local Proxy endpoints on `127.0.0.1` or `localhost` and rejects URLs containing embedded credentials. Supporting authenticated or non-loopback proxies would require secrets and external network trust to cross local profiles, remote environment files, shell history, diagnostics, and rollback records; secure storage on the local computer alone would not eliminate those remote exposure paths. The common loopback-proxy use case does not justify that trust expansion yet.

## Consequences

Support Reports redact user names, host addresses, paths, proxy details, tokens, and credentials and are never uploaded automatically. Existing proxy values containing embedded credentials or other secret material are not eligible for automatic replacement because exact Rollback would require secret compensation data. Authenticated corporate proxies remain unsupported until their end-to-end secret lifecycle is designed explicitly.
