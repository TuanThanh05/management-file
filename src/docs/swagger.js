import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApi } from './openapi.js';

// Mở Swagger UI tại /api/docs và JSON tại /api/docs/openapi.json (chỉ bật khi không chạy production)
export function mountApiDocs(app) {
  let spec;
  const getSpec = () => (spec ??= buildOpenApi(app));
  app.get('/api/docs/openapi.json', (req, res) => res.json(getSpec()));
  app.use('/api/docs',
    helmet.contentSecurityPolicy({ directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'] } }),
    swaggerUi.serve,
    (req, res, next) => swaggerUi.setup(getSpec(), { customSiteTitle: 'API lưu trữ và hủy dữ liệu' })(req, res, next));
}
