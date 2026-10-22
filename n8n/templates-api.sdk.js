import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

// Proxy between the Ikris dashboard (Supabase edge function "wa-campaigns") and the
// WhatsApp Cloud API. The Meta access token stays inside the n8n WhatsApp credential.
const WA_CREDENTIAL = { whatsAppApi: { id: 'nSIYGJ5ZnCM2vzdD', name: 'WhatsApp account' } };

const httpOptions = { timeout: 30000, response: { response: { fullResponse: true, neverError: true } } };

const apiCall = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Dashboard API call',
    parameters: { httpMethod: 'POST', path: 'ikris-wa-api', responseMode: 'responseNode', options: {} }
  },
  output: [{ headers: { 'x-ikris-secret': 'secret' }, body: { action: 'list_templates' } }]
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
  output: [{ headers: {}, body: { action: 'list_templates' } }]
});

const route = switchCase({
  version: 3.2,
  config: {
    name: 'Route action',
    parameters: {
      rules: { values: [
        { outputKey: 'list', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.body.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'list_templates' }], combinator: 'and' } },
        { outputKey: 'create', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.body.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'create_template' }], combinator: 'and' } },
        { outputKey: 'send', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.body.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'send_template' }], combinator: 'and' } },
        { outputKey: 'delete', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.body.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'delete_template' }], combinator: 'and' } }
      ] },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Unknown' }
    }
  },
  output: [{ headers: {}, body: { action: 'list_templates' } }]
});

const listTemplates = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'List templates',
    parameters: {
      method: 'GET',
      url: 'https://graph.facebook.com/v23.0/2277080626413317/message_templates',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'whatsAppApi',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: { parameters: [
        { name: 'limit', value: '250' },
        { name: 'fields', value: 'id,name,status,category,language,components,rejected_reason,quality_score' }
      ] },
      options: httpOptions
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ statusCode: 200, body: { data: [] } }]
});

const createTemplate = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Create template',
    parameters: {
      method: 'POST',
      url: 'https://graph.facebook.com/v23.0/2277080626413317/message_templates',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'whatsAppApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.body.template) }}'),
      options: httpOptions
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ statusCode: 200, body: { id: '123', status: 'PENDING', category: 'MARKETING' } }]
});

const sendTemplate = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Send template message',
    parameters: {
      method: 'POST',
      url: 'https://graph.facebook.com/v23.0/1349374634922231/messages',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'whatsAppApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String($json.body.to), type: 'template', template: { name: $json.body.name, language: { code: $json.body.language }, components: $json.body.components || [] } }) }}"),
      options: httpOptions
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ statusCode: 200, body: { messages: [{ id: 'wamid.ABC' }] } }]
});

const deleteTemplate = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Delete template',
    parameters: {
      method: 'DELETE',
      url: 'https://graph.facebook.com/v23.0/2277080626413317/message_templates',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'whatsAppApi',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: { parameters: [{ name: 'name', value: expr('{{ $json.body.name }}') }] },
      options: httpOptions
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ statusCode: 200, body: { success: true } }]
});

const replyResult = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: result',
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: $json.statusCode >= 200 && $json.statusCode < 300, status: $json.statusCode, data: $json.body }) }}"),
      options: {}
    }
  },
  output: [{ ok: true }]
});

const replyUnknown = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: unknown action',
    parameters: { respondWith: 'json', responseBody: '{ "ok": false, "error": "unknown action" }', options: { responseCode: 400 } }
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

export default workflow('ikris-wa-templates-api', 'Ikris Dashboard – WhatsApp templates & campaigns API')
  .add(apiCall)
  .to(secretOk
    .onTrue(route
      .onCase(0, listTemplates.to(replyResult))
      .onCase(1, createTemplate.to(replyResult))
      .onCase(2, sendTemplate.to(replyResult))
      .onCase(3, deleteTemplate.to(replyResult))
      .onCase(4, replyUnknown))
    .onFalse(replyUnauthorized));
