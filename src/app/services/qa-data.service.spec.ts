import { QaDataService } from './qa-data.service';

describe('QaDataService', () => {
  let service: QaDataService;

  beforeEach(() => {
    localStorage.clear();
    service = new QaDataService();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should return empty array when storage contains invalid JSON', () => {
    localStorage.setItem('udemy_unanswered_v1', '{bad json');
    expect(service.getAll()).toEqual([]);
  });

  it('should deep-merge incoming items by stable key', () => {
    service.setAll([
      {
        id: 'abc',
        title: 'Original',
        link: 'https://www.udemy.com/q/abc',
        answered: false,
        courseInfo: { id: '1', title: 'Course A', url: 'https://www.udemy.com/course/a' }
      }
    ]);

    const merged = service.merge([
      {
        id: 'abc',
        title: 'Updated title',
        link: 'https://www.udemy.com/q/abc',
        answered: true,
        has_instructor_reply: true,
        courseInfo: { id: '1', title: 'Course A Updated' }
      }
    ]);

    expect(merged.length).toBe(1);
    expect(merged[0].title).toBe('Updated title');
    expect(merged[0].has_instructor_reply).toBeTrue();
    expect(merged[0].courseInfo?.id).toBe('1');
    expect(merged[0].courseInfo?.title).toBe('Course A Updated');
    expect(merged[0].courseInfo?.url).toBe('https://www.udemy.com/course/a');
  });
});
