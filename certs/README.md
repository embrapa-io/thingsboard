# Certificados MQTTS

Este diretório recebe os certificados locais utilizados pelo transporte MQTTS.

Arquivos gerados no ambiente de desenvolvimento:

- ca.pem: certificado público da autoridade certificadora local;
- ca_key.pem: chave privada da autoridade certificadora local;
- server.pem: certificado do servidor ThingsBoard;
- server_key.pem: chave privada do servidor ThingsBoard.

Somente este README é versionado. Todos os certificados, chaves, requisições e arquivos temporários deste diretório são ignorados pelo Git.

O certificado ca.pem pode ser distribuído aos simuladores e devices que precisam confiar no servidor local. Os arquivos ca_key.pem e server_key.pem são secretos e nunca devem ser copiados para o dashboard, enviados por e-mail ou adicionados ao Git.

O ThingsBoard precisará apenas de server.pem e server_key.pem em tempo de execução. A chave ca_key.pem deve permanecer fora do container.

No Windows, o gerador mantém a ACL das chaves privadas restrita ao usuário atual e ajusta somente o modo de arquivo apresentado pelo Docker Desktop, permitindo que o usuário interno do ThingsBoard leia server_key.pem.

Para produção, não reutilize estes arquivos. Utilize certificado emitido para o domínio definitivo e armazene a chave privada usando o mecanismo de segredos do ambiente.
