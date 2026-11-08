export const buildQueryParams = (params: Record<string, any>): string => {
  const queryParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item !== undefined && item !== null && item !== '') {
            queryParams.append(key, item.toString());
          }
        });
      } else {
        queryParams.append(key, value.toString());
      }
    }
  });

  return queryParams.toString() ? `?${queryParams.toString()}` : '';
};
