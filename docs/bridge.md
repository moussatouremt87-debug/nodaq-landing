# Agrégateur bancaire DSP2 — Bridge (ticket 2.15)

Qonto ne couvre qu'une néobanque. **Bridge** (bridgeapi.io, agrégateur
français agréé DSP2) ouvre nodaq à **toutes les banques françaises** : le
client `BridgeClient` expose la même interface que Qonto, et tous les
consommateurs bancaires (prévision de trésorerie, cockpit, rapprochement du
classeur, outils MCP de l'employé Compta) passent par **`getBankClient()`** :

```
getBankClient(tenantId) :
  connecteur qonto présent  -> QontoClient   (accès direct, prioritaire)
  sinon connecteur bridge   -> BridgeClient  (agrégateur, toutes banques)
  sinon                     -> ConnectorNotConfiguredError
```

## Onboarding

/connecteurs → carte **« Bridge — toutes banques »** : `Client ID`,
`Client Secret` (masqué), `UUID utilisateur Bridge`. Comme tout connecteur :
identifiants **testés contre le fournisseur** (token + liste des comptes)
avant d'entrer au coffre (`connector/<tenantId>/bridge`), jamais renvoyés,
remplacement = rotation, suppression = effacement coffre puis ligne.

**V1 assumée** : le `userUuid` désigne un utilisateur Bridge dont la banque
est déjà reliée (créé côté dashboard/sandbox Bridge). Le **flux Bridge
Connect hébergé** (l'artisan choisit sa banque et s'authentifie dans un
parcours web) est la suite naturelle — il demande une URL de redirection et
des webhooks, prévu dans un ticket dédié.

## Mapping (client lecture seule, minimisation)

- Comptes Bridge → `bank_accounts` forme Qonto (`balance` euros → cents
  arrondis) ; transactions → forme Qonto (`amount < 0` → `debit`, dates
  seules → ISO UTC, `clean_description` → `label`). Les champs inconnus sont
  éliminés par Zod (strip).
- Auth : en-têtes applicatifs `Client-Id`/`Client-Secret` + token
  utilisateur (POST `/aggregation/authorization/token`, mis en cache
  d'instance). Aucun identifiant ni token dans les messages d'erreur/logs.
- La doc officielle Bridge est inaccessible depuis l'environnement de dev
  (proxy) : le contrat est documenté en tête de `bridge.ts` et TOUT est
  surchargeable (`BRIDGE_BASE_URL`, `BRIDGE_API_VERSION`) pour coller au
  sandbox réel sans changer le code.

## À ne pas faire

- Appeler `getQontoClient`/`getBridgeClient` directement depuis un
  consommateur métier : toujours `getBankClient` (agnostique).
- Logger un solde, un libellé de transaction ou un IBAN (donnée bancaire =
  confidentielle ; seuls des compteurs/noms d'erreur sortent).
