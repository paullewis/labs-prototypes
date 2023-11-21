## openai-gpt-35-turbo.ts

```mermaid
%%{init: 'themeVariables': { 'fontFamily': 'Fira Code, monospace' }}%%
graph TD;
secrets2("secrets <br> id='secrets-2'"):::secrets -- "OPENAI_API_KEY->json" --> jsonata1["jsonata <br> id='jsonata-1'"]
jsonata1["jsonata <br> id='jsonata-1'"] -- "result->headers" --> fetch4["fetch <br> id='fetch-4'"]
jsonata5["jsonata <br> id='jsonata-5'"] -- "result->text" --> output{{"output <br> id='output'"}}:::output
fetch4["fetch <br> id='fetch-4'"] -- "response->json" --> jsonata5["jsonata <br> id='jsonata-5'"]
jsonata3["jsonata <br> id='jsonata-3'"] -- "result->body" --> fetch4["fetch <br> id='fetch-4'"]
input[/"input <br> id='input'"/]:::input -- "text->json" --> jsonata3["jsonata <br> id='jsonata-3'"]
classDef default stroke:#ffab40,fill:#fff2ccff,color:#000
classDef input stroke:#3c78d8,fill:#c9daf8ff,color:#000
classDef output stroke:#38761d,fill:#b6d7a8ff,color:#000
classDef passthrough stroke:#a64d79,fill:#ead1dcff,color:#000
classDef slot stroke:#a64d79,fill:#ead1dcff,color:#000
classDef config stroke:#a64d79,fill:#ead1dcff,color:#000
classDef secrets stroke:#db4437,fill:#f4cccc,color:#000
classDef slotted stroke:#a64d79
```