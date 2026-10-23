import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

// Downloads a file a customer sent on WhatsApp (by media id) and returns the bytes
// to the Supabase "chat-ingest" / "chat-media" edge functions, which store it in the
// private chat-attachments bucket. The Meta access token stays in the n8n credential.
const WA_CREDENTIAL = { whatsAppApi: { id: 'nSIYGJ5ZnCM2vzdD', name: 'WhatsApp account' } };

const call = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Media request',
    parameters: { httpMethod: 'POST', path: 'ikris-wa-media-get', responseMode: 'responseNode', options: {} }
  },
  output: [{ headers: { 'x-ikris-secret': 'secret' }, body: { media_id: '123' } }]
});

const secretOk = ifElse({
  version: 2.2,
  config: {
    name: 'Secret OK?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{
          leftValue: expr("{{ $json.headers['x-ikris-secret'] }}"),
          operator: { type: 'string', operation: 'equals' },
          rightValue: 'REPLACE_WITH_IKRIS_SECRET'
        }],
        combinator: 'and'
      }
    }
  },
  output: [{ headers: {}, body: { media_id: '123' } }]
});

const getInfo = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Get media info',
    parameters: {
      method: 'GET',
      url: expr("{{ 'https://graph.facebook.com/v23.0/' + encodeURIComponent(String($json.body.media_id)) }}"),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'whatsAppApi',
      options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true } } }
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ statusCode: 200, body: { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg', file_size: 1000 } }]
});

const found = ifElse({
  version: 2.2,
  config: {
    name: 'Found?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{
          leftValue: expr('{{ $json.statusCode == 200 && !!$json.body.url }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: ''
        }],
        combinator: 'and'
      }
    }
  },
  output: [{ statusCode: 200, body: { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' } }]
});

const download = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Download media',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.body.url }}'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'whatsAppApi',
      options: { timeout: 120000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } }
    },
    credentials: WA_CREDENTIAL
  },
  output: [{}]
});

const replyFile = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: file',
    parameters: {
      respondWith: 'binary',
      inputDataFieldName: 'data',
      options: {
        responseHeaders: { entries: [
          { name: 'Content-Type', value: expr("{{ $('Get media info').item.json.body.mime_type || 'application/octet-stream' }}") },
          { name: 'x-media-mime', value: expr("{{ $('Get media info').item.json.body.mime_type || '' }}") }
        ] }
      }
    }
  },
  output: [{}]
});

const replyMissing = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: not found',
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: false, error: ($json.body && $json.body.error && $json.body.error.message) || 'media not found' }) }}"),
      options: { responseCode: 404 }
    }
  },
  output: [{ ok: false }]
});

const replyUnauthorized = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: unauthorized',
    parameters: { respondWith: 'json', responseBody: '{ "ok": false, "error": "unauthorized" }', options: { responseCode: 401 } }
  },
  output: [{ ok: false }]
});

export default workflow('ikris-wa-media-get', 'Ikris Dashboard – download customer WhatsApp media')
  .add(call)
  .to(secretOk
    .onTrue(getInfo.to(found
      .onTrue(download.to(replyFile))
      .onFalse(replyMissing)))
    .onFalse(replyUnauthorized));
