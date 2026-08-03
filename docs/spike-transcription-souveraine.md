# Spike F1 — la transcription peut-elle rester souveraine ?

> **Verdict : oui, et sur le fournisseur qu'on utilise déjà.** Le risque n°1 du
> plan de pivot est nettement réduit. Il reste un risque, mais ce n'est plus
> celui qu'on croyait.

Le brief de pivot désigne F1 (dictée → devis) comme « le seul risque technique
sérieux du plan » et demande d'en lancer le spike dès la première semaine. La
crainte était fondée : la règle n°1 du `CLAUDE.md` interdit qu'une donnée
`confidentiel` quitte le tier souverain, ce qui exclut d'emblée les deux moteurs
de transcription que tout le monde utilise (Whisper **API** d'OpenAI, Deepgram).

## Ce que le spike a établi

**Scaleway Generative APIs — notre fournisseur actuel — expose
`/v1/audio/transcriptions`**, compatible OpenAI, avec `whisper-large-v3`.
Facturation à la **seconde d'audio**, pas au token. Formats : `wav`, `mp3`,
`flac`, `mpga`, `oga`, `ogg`. La langue peut être imposée en ISO-639-1 (`fr`),
ou détectée — l'imposer est préférable, deviner coûte de la précision.

Conséquences concrètes, et elles sont importantes :

- **aucun nouveau fournisseur, aucun nouveau contrat, aucun nouveau flux de
  données** à faire valider. C'est le même `api.scaleway.ai`, la même clé, le
  même tier ;
- **LiteLLM sait router ce type d'appel** (`model_info: mode: audio_transcription`),
  donc la règle « tout appel modèle passe par LiteLLM » tient sans exception ;
- deux **replis souverains/UE** existent si Scaleway déçoit : **Voxtral**
  (Mistral, UE) et **OVHcloud AI Endpoints** (FR), tous deux supportés par
  LiteLLM. Un troisième repli reste l'auto-hébergement de Whisper en poids
  ouverts, sur le modèle de `services/ocr` — plus cher en exploitation, mais il
  ne dépend de personne.

## Ce que le spike a livré en code

Le spike ne construit pas F1. Il verrouille la seule partie qui, mal faite,
serait irrattrapable : **le chemin par lequel l'audio sort**.

`packages/llm/src/transcribe.ts` — `transcribe()`, à côté de `route()` et
`embed()`.

**Le point qui commande tout** : on ne peut pas classifier ce qu'on n'a pas
encore lu. Le classifier travaille sur du texte ; devant un fichier audio, il
n'a rien à analyser. Il n'existe donc **aucun chemin honnête** où une dictée
serait jugée `non_sensible` avant transcription.

D'où :

| Décision | Pourquoi |
|---|---|
| catégorie **fixée** à `confidentiel` | comme les photos de documents (2.16), « par construction » — une dictée de devis contient un nom de client, une adresse de chantier et des prix |
| **aucun** paramètre de groupe, ni `preferFrontier`, ni `forceGroup` | contrairement à `route()`, aucun appelant ne peut demander le tier frontier, même par erreur |
| garde dure conservée malgré tout | deux verrous valent mieux qu'un commentaire |
| audit de l'empreinte de l'**audio**, jamais du texte obtenu | auditer le texte reviendrait à stocker en clair le nom du client et le prix |
| `category` rendue à l'appelant | pour qu'il la **propage** : le texte issu d'une dictée reste confidentiel, et ne doit pas repartir vers un modèle frontier à l'étape suivante |

Cinq tests verrouillent ça — dont un qui vérifie qu'aucune API ne permet de
demander un tier non souverain. Sa première version échouait sur sa **propre
documentation**, qui cite `preferFrontier` pour expliquer son absence : les
commentaires sont désormais retirés avant l'examen. Une garde qui se déclenche
sur de la prose ne garde rien — elle apprend seulement à ne plus rien écrire.

## Le risque qui reste, et il a changé de nature

Le risque n'est plus « peut-on transcrire souverainement » (oui) mais
**« la transcription est-elle assez bonne sur le vocabulaire du bâtiment,
dictée dans le bruit d'un chantier »**.

C'est un risque de **qualité**, pas d'architecture — donc il ne remet pas en
cause le plan, il conditionne l'ergonomie de F1. Whisper-large-v3 est réputé
solide en français général ; personne ici ne peut affirmer ce qu'il fait sur
« deux ml de plinthe en chêne » ou « placo BA13 hydro », dicté près d'une
disqueuse.

**Ce spike ne peut pas trancher cette question** : elle demande de vrais
enregistrements et une clé API, dont ni l'un ni l'autre n'existent dans cet
environnement. Le dire vaut mieux que produire un chiffre inventé.

### Protocole proposé pour le fermer (une demi-journée)

1. enregistrer **dix dictées réelles** de devis, dont au moins trois en
   extérieur ou en environnement bruyant ;
2. les transcrire via `transcribe()` et **compter les erreurs sur ce qui
   compte** : quantités, unités, prix, noms propres. Une faute d'orthographe sur
   un mot courant est sans conséquence ; « 2,5 » devenu « 25 » ne l'est pas ;
3. si le taux d'erreur sur les **nombres** dépasse quelques pourcents, la
   conclusion n'est pas « changer de moteur » mais **changer la boucle** : faire
   dicter ligne par ligne avec relecture à l'écran, plutôt qu'un monologue
   transcrit d'un bloc. C'est de toute façon ce que la doctrine HITL impose —
   l'assistant prépare, l'humain valide.

## Impact sur l'estimation

Le plan budgète F1 à **8-10 jours**. Rien dans ce spike ne le contredit :
l'intégration technique est plus simple qu'on ne le craignait (pas de nouveau
fournisseur), mais l'essentiel de la charge de F1 n'a jamais été la
transcription — c'est le passage du **texte libre au devis structuré** (lignes,
quantités, unités, TVA), et la boucle de correction.

Le point de vigilance se déplace donc vers la **structuration**, et il relève de
règles déjà écrites : ne jamais inventer une quantité ou un prix qui n'a pas été
dicté, dire ce qui manque, et faire valider avant d'écrire quoi que ce soit.

## Sources

- [Scaleway — How to query audio models](https://www.scaleway.com/en/docs/generative-apis/how-to/query-audio-models/)
- [Scaleway — Create an audio transcription (API)](https://www.scaleway.com/en/developers/api/generative-apis/audio)
- [Scaleway — Model-as-a-service pricing](https://www.scaleway.com/en/pricing/model-as-a-service/)
- [LiteLLM — /audio/transcriptions](https://docs.litellm.ai/docs/audio_transcription)
- [LiteLLM — Scaleway provider](https://docs.litellm.ai/docs/providers/scaleway)

> Les pages Scaleway ont été lues via recherche : l'accès direct est bloqué par
> le proxy de cet environnement (403). **Le nom exact du modèle et les limites
> de taille sont donc à confirmer en console** avant le premier appel réel —
> c'est d'ailleurs déjà la consigne portée par `ops/litellm/config.yaml`.
