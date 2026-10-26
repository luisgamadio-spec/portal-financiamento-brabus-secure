# Cópia de segurança: brabus-intelligence v40 (publicada até 26/10/2026)

Baixada de produção com `supabase functions download brabus-intelligence` antes do deploy da utilização.
Idêntica ao branch antes do commit da utilização (os arquivos de runtime). Acesso decidido pelo segredo BI_PERFIS
(= "MASTER,DIRETOR,GERENTE,ANALISTA,VENDEDOR", identificado pelo digest).

Para desfazer a função, publique esta pasta de novo, a partir de um clone com supabase/functions:

    cp -r docs/brabus-ia-utilizacao/funcao_v40_antes/. supabase/functions/brabus-intelligence/   # (sem este LEIA.md)
    supabase functions deploy brabus-intelligence --project-ref yacqlelpzchcotgngwbh
