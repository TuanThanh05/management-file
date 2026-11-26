// Kiểm tra body/query/params bằng zod; kết quả đã chuẩn hóa đặt vào req.input
export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    req.input = {
      body: body ? body.parse(req.body ?? {}) : undefined,
      query: query ? query.parse(req.query ?? {}) : undefined,
      params: params ? params.parse(req.params ?? {}) : undefined,
    };
    next();
  };
}
